import socket
import queue
import json
import time
import os
import sys
import urllib.request
import zipfile
import shutil
import subprocess

try:
    import sounddevice as sd
    import numpy as np
    from vosk import Model, KaldiRecognizer
except ModuleNotFoundError as exc:
    missing_modulo = exc.name
    print(f"[VOSK] Falta módulo Python: {missing_modulo}. Intentando instalar dependencias...")

    def instalar_dependencias():
        paquetes = ["sounddevice", "vosk", "numpy"]
        comando = [sys.executable, "-m", "pip", "install", "--user", "--no-warn-script-location"] + paquetes
        try:
            resultado = subprocess.run(comando, check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            print(resultado.stdout)
        except subprocess.CalledProcessError as e:
            print("[VOSK] No se pudieron instalar dependencias automáticamente.")
            print(e.stdout)
            print("[VOSK] Cierra todas las ventanas de Python y prueba manualmente:")
            print(f"    {sys.executable} -m pip install --user --no-warn-script-location sounddevice vosk numpy")
            sys.exit(1)

    instalar_dependencias()

    try:
        import sounddevice as sd
        import numpy as np
        from vosk import Model, KaldiRecognizer
    except ModuleNotFoundError as e:
        print(f"[VOSK] Aún falta el módulo: {e.name}. Instala manualmente:")
        print(f"    {sys.executable} -m pip install --user --no-warn-script-location sounddevice vosk numpy")
        sys.exit(1)

# ── Configuración de modelos y audio ─────────────────────────
MODELO_ZIP_URL = "https://alphacephei.com/vosk/models/vosk-model-small-es-0.22.zip"
MODELO_ARCHIVO = "vosk-model-small-es-0.22.zip"
MODELO_EXTRAIDO = "vosk-model-small-es-0.22"
WAKE_KEYWORD = "lila"
WAKE_GRAMMAR = f'["{WAKE_KEYWORD}"]'
TIEMPO_GRACIA = 3.0
TIEMPO_SILENCIO = 0.6
MAX_COMMAND_DURATION = 14.0
DEBUG_VOSK = False

# ── Configuración de Rutas para Empaquetado (CRÍTICO) ──────────
def get_resource_path(relative_path):
    """Obtiene la ruta absoluta al recurso, funciona para dev y para PyInstaller .exe"""
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, relative_path)
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), relative_path)

HOST = '127.0.0.1'
PORT = 5005


q = queue.Queue(maxsize=100)

def callback(indata, frames, time_info, status):
    if status:
        print(f"[STATUS] {status}")
    try:
        q.put_nowait(bytes(indata))
    except queue.Full:
        try:
            q.get_nowait()
            q.put_nowait(bytes(indata))
        except:
            pass

def enviar_a_java(mensaje):
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.connect((HOST, PORT))
        s.sendall((mensaje + "\n").encode('utf-8'))
        s.close()
    except Exception as e:
        print(f"[ERROR SOCKET] {e}")

def limpiar_cola():
    while not q.empty():
        try:
            q.get_nowait()
        except queue.Empty:
            break


def capturar_comando(rec_comando, max_duration=MAX_COMMAND_DURATION):
    inicio = time.time()
    ultimo_sonido = time.time()
    ya_hablo = False
    comando_completo = ""

    while True:
        try:
            data_cmd = q.get(timeout=0.12)
        except queue.Empty:
            if not ya_hablo and (time.time() - inicio) >= TIEMPO_GRACIA:
                break
            if ya_hablo and (time.time() - ultimo_sonido) >= TIEMPO_SILENCIO:
                break
            if (time.time() - inicio) >= max_duration:
                break
            continue

        if rec_comando.AcceptWaveform(data_cmd):
            res = json.loads(rec_comando.Result())
            chunk = res.get("text", "").strip()
            if chunk:
                comando_completo += " " + chunk
                ultimo_sonido = time.time()
                ya_hablo = True
                if DEBUG_VOSK:
                    print(f"[VOSK CMD RESULT] {chunk}")
        else:
            parcial = json.loads(rec_comando.PartialResult()).get("partial", "")
            if parcial:
                if DEBUG_VOSK:
                    print(f"[VOSK CMD PARTIAL] {parcial}")
                ultimo_sonido = time.time()
                ya_hablo = True

        if ya_hablo and (time.time() - ultimo_sonido) >= TIEMPO_SILENCIO:
            res_final = json.loads(rec_comando.FinalResult())
            comando_completo += " " + res_final.get("text", "").strip()
            break

        if (time.time() - inicio) >= max_duration:
            break

    return comando_completo.strip()


def descargar_y_extraer_modelo(destino):
    carpeta_base = os.path.dirname(__file__)
    archivo_zip = os.path.join(carpeta_base, MODELO_ARCHIVO)

    if os.path.exists(destino):
        return

    print(f"[VOSK] No se encontró modelo VOSK en {destino}. Descargando modelo español...")
    try:
        urllib.request.urlretrieve(MODELO_ZIP_URL, archivo_zip)
        print("[VOSK] Descarga completa. Extrayendo modelo...")
        with zipfile.ZipFile(archivo_zip, 'r') as zip_ref:
            zip_ref.extractall(carpeta_base)

        extraido = os.path.join(carpeta_base, MODELO_EXTRAIDO)
        if os.path.isdir(extraido):
            if os.path.exists(destino):
                shutil.rmtree(destino)
            shutil.move(extraido, destino)
        else:
            # Si la carpeta tiene nombre distinto, busca un candidato
            for nombre in os.listdir(carpeta_base):
                candidato = os.path.join(carpeta_base, nombre)
                if os.path.isdir(candidato) and nombre.startswith("vosk-model"):
                    if os.path.exists(destino):
                        shutil.rmtree(destino)
                    shutil.move(candidato, destino)
                    break

        print(f"[VOSK] Modelo listo en: {destino}")
    except Exception as e:
        raise Exception(f"No se pudo descargar o extraer el modelo VOSK: {e}")
    finally:
        if os.path.exists(archivo_zip):
            os.remove(archivo_zip)


# ── Carga del modelo (Adaptado para .exe) ──────────────────────
try:
    # IMPORTANTE: Aquí buscamos la carpeta 'vosk-model'
    modelo_path = get_resource_path("vosk-model")
    print(f"[VOSK] Buscando modelo en: {modelo_path}")

    if not os.path.exists(modelo_path):
        descargar_y_extraer_modelo(modelo_path)

    model = Model(modelo_path)
    print("[VOSK] ¡Modelo cargado exitosamente!")
except Exception as e:
    print(f"[ERROR CRÍTICO] {e}")
    input("Presiona ENTER para cerrar...")
    sys.exit(1)

# ── Bucle Principal ──────────────────────────────────────────
try:
    with sd.RawInputStream(samplerate=16000, blocksize=400, dtype='int16',
                           channels=1, callback=callback, latency='low'):

        wake_recognizer = KaldiRecognizer(model, 16000, WAKE_GRAMMAR)
        print("L.I.L.A. Escuchando en modo reposo. Di 'LILA' para activar el comando.\n")

        while True:
            data = q.get()

            if wake_recognizer.AcceptWaveform(data):
                result_data = json.loads(wake_recognizer.Result())
                detected = result_data.get("text", "").strip().lower()
                if WAKE_KEYWORD in detected.split():
                    print(f"\n[WAKE] '{WAKE_KEYWORD.upper()}' detectado. Activando Vosk para comando.")
                    enviar_a_java("DESPIERTA")
                    limpiar_cola()

                    rec_comando = KaldiRecognizer(model, 16000)
                    print("[LILA] Grabando comando...")

                    comando_final = capturar_comando(rec_comando)
                    if comando_final:
                        print(f"[COMANDO]: {comando_final}")
                        enviar_a_java(f"COMANDO:{comando_final}")
                    else:
                        enviar_a_java("NADA")

                    limpiar_cola()
                    wake_recognizer = KaldiRecognizer(model, 16000, WAKE_GRAMMAR)
                    print("\nL.I.L.A. Escuchando en modo reposo. Di 'LILA' para activar el comando.\n")
            else:
                partial_data = json.loads(wake_recognizer.PartialResult())
                partial_text = partial_data.get("partial", "").strip().lower()
                if WAKE_KEYWORD in partial_text.split():
                    print(f"\n[WAKE] '{WAKE_KEYWORD.upper()}' detectado por parcial. Activando Vosk para comando.")
                    enviar_a_java("DESPIERTA")
                    limpiar_cola()

                    rec_comando = KaldiRecognizer(model, 16000)
                    print("[LILA] Grabando comando...")

                    comando_final = capturar_comando(rec_comando)
                    if comando_final:
                        print(f"[COMANDO]: {comando_final}")
                        enviar_a_java(f"COMANDO:{comando_final}")
                    else:
                        enviar_a_java("NADA")

                    limpiar_cola()
                    wake_recognizer = KaldiRecognizer(model, 16000, WAKE_GRAMMAR)
                    print("\nL.I.L.A. Escuchando en modo reposo. Di 'LILA' para activar el comando.\n")

except Exception as e:
    print(f"[ERROR DE BUCLE] {e}")
    input("Presiona ENTER para cerrar...")