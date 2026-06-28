# reproducir_musica.py — Reproduce musica en YouTube Music en segundo plano
import sys
import time
import os
import traceback
import socket
import urllib.parse
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager
from webdriver_manager.core.os_manager import ChromeType

DEFAULT_BRAVE_PATH = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
DEFAULT_BASE_DIR = r"C:\ARCHIVOSLILA"
DEBUG_PORT = int(os.getenv("LILA_BRAVE_DEBUG_PORT", "9222"))


def get_brave_path():
    return os.getenv("LILA_BRAVE_PATH", DEFAULT_BRAVE_PATH)


def get_brave_profile():
    perfil = os.getenv("LILA_BRAVE_PROFILE")
    if perfil and perfil.strip():
        return os.path.abspath(perfil.strip())
    base_dir = os.getenv("LILA_BASE_DIR", DEFAULT_BASE_DIR)
    return os.path.abspath(os.path.join(base_dir, "brave_profile"))


def crear_opciones_base():
    opciones = Options()
    opciones.add_argument("--disable-extensions")
    opciones.add_argument("--disable-notifications")
    opciones.add_argument("--no-first-run")
    opciones.add_argument("--no-default-browser-check")
    opciones.add_argument("--autoplay-policy=no-user-gesture-required")
    opciones.add_argument("--disable-background-timer-throttling")
    opciones.add_argument("--disable-backgrounding-occluded-windows")
    opciones.add_argument("--disable-renderer-backgrounding")
    opciones.add_argument("--disable-gpu")
    opciones.add_argument("--disable-dev-shm-usage")
    opciones.add_argument("--disable-blink-features=AutomationControlled")
    opciones.add_experimental_option("excludeSwitches", ["enable-automation"])
    opciones.add_experimental_option("useAutomationExtension", False)
    return opciones


def puerto_debug_abierto():
    try:
        with socket.create_connection(("127.0.0.1", DEBUG_PORT), timeout=0.5):
            return True
    except Exception:
        return False


def obtener_driver():
    brave_path = get_brave_path()
    brave_profile = get_brave_profile()
    os.makedirs(brave_profile, exist_ok=True)

    servicio = Service(ChromeDriverManager(chrome_type=ChromeType.BRAVE).install()) if os.path.exists(brave_path) else Service(ChromeDriverManager().install())

    if os.path.exists(brave_path):
        print(f"[LILA] Navegador detectado: Brave ({brave_path})")
    else:
        print("[LILA] Navegador detectado: Chrome")

    if puerto_debug_abierto():
        opciones_reconnect = crear_opciones_base()
        if os.path.exists(brave_path):
            opciones_reconnect.binary_location = brave_path
        opciones_reconnect.add_argument(f"--user-data-dir={brave_profile}")
        opciones_reconnect.add_argument("--profile-directory=Default")
        opciones_reconnect.add_experimental_option("debuggerAddress", f"127.0.0.1:{DEBUG_PORT}")

        try:
            driver = webdriver.Chrome(service=servicio, options=opciones_reconnect)
            print(f"[LILA] Reconectado a sesión existente en puerto {DEBUG_PORT}.")
            return driver
        except Exception as e:
            print(f"[LILA] Reconexión fallida: {e}")

    opciones_new = crear_opciones_base()
    if os.path.exists(brave_path):
        opciones_new.binary_location = brave_path
    opciones_new.add_argument(f"--user-data-dir={brave_profile}")
    opciones_new.add_argument("--profile-directory=Default")
    opciones_new.add_argument(f"--remote-debugging-port={DEBUG_PORT}")

    driver = webdriver.Chrome(service=servicio, options=opciones_new)
    print(f"[LILA] Abierta nueva sesión con depuración remota en puerto {DEBUG_PORT}.")
    return driver

def reproducir_cancion(busqueda, espera=5, modo="cancion"):
    driver = obtener_driver()
    wait = WebDriverWait(driver, 20)

    try:
        try:
            url_actual = driver.current_url
        except Exception:
            url_actual = ""

        if not url_actual.startswith("https://music.youtube.com"):
            driver.get("https://music.youtube.com")

        search_input = None
        try:
            search_input = driver.find_element(By.CSS_SELECTOR, "input#input, input[aria-label*='Buscar'], input[aria-label*='Search']")
        except Exception:
            search_button = wait.until(EC.element_to_be_clickable(
                (By.XPATH, "//button[@id='search-icon' or contains(@aria-label,'Buscar') or contains(@aria-label,'Search')]")
            ))
            driver.execute_script("arguments[0].click();", search_button)
            search_input = wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "input#input, input[aria-label*='Buscar'], input[aria-label*='Search']")))

        driver.execute_script("arguments[0].focus(); arguments[0].value = ''; arguments[0].dispatchEvent(new Event('input', { bubbles: true }));", search_input)
        driver.execute_script("arguments[0].value = arguments[1]; arguments[0].dispatchEvent(new Event('input', { bubbles: true })); arguments[0].focus();", search_input, busqueda)
        search_input.send_keys(Keys.ENTER)

        play_button = None
        posible_selectores = [
            "(//ytmusic-play-button-renderer//button)[1]",
            "(//button[contains(@aria-label,'Reproducir') or contains(@aria-label,'Play')])[1]",
            "(//ytmusic-responsive-list-item-renderer//button[@aria-label])[1]",
            "(//ytmusic-shelf-renderer//button[@aria-label])[1]"
        ]
        for xpath in posible_selectores:
            try:
                play_button = wait.until(EC.element_to_be_clickable((By.XPATH, xpath)))
                if play_button:
                    break
            except Exception:
                continue

        if play_button is None:
            raise Exception("No se encontró botón de reproducción en los resultados de YouTube Music.")

        driver.execute_script("arguments[0].click();", play_button)

        print(f"[LILA] Audio iniciado en segundo plano: {busqueda}")

    except Exception as e:
        print(f"[LILA ERROR] {e}")
        print("[LILA] No se pudo procesar el play automatico.")

    print("[LILA] Puedes abrir la ventana desde tu barra de tareas cuando quieras.")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Uso: python reproducir_musica.py <busqueda> [segundos] [modo]")
        sys.exit(1)
    try:
        busqueda = sys.argv[1]
        espera   = int(sys.argv[2]) if len(sys.argv) > 2 else 5
        modo     = sys.argv[3]      if len(sys.argv) > 3 else "cancion"
        reproducir_cancion(busqueda, espera, modo=modo)
    except Exception as e:
        print(f"ERROR FATAL: {e}")
        traceback.print_exc()