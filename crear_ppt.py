# crear_ppt.py — Crea presentaciones PowerPoint con texto y apoyos visuales
# Uso: python crear_ppt.py "ruta.pptx" "ruta_contenido.txt" "true/false"

import sys
import os
import re
import tempfile
import urllib.request
from urllib.parse import urlparse
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE
from pptx.util import Inches, Pt


def descargar_imagen(url):
    parsed = urlparse(url)
    if parsed.scheme and parsed.netloc:
        tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(parsed.path)[1] or ".png")
        try:
            with urllib.request.urlopen(url, timeout=20) as response:
                tmp_file.write(response.read())
            return tmp_file.name
        except Exception:
            return None
        finally:
            tmp_file.close()

def crear_portada(prs, titulo="Presentación", subtitulo=None):
    slide_layout = prs.slide_layouts[0]
    slide = prs.slides.add_slide(slide_layout)
    title = slide.shapes.title
    subtitle = slide.placeholders[1]
    title.text = titulo
    subtitle.text = subtitulo or "Creada por LILA"
    return slide


def agregar_texto_slide(prs, titulo, texto):
    slide_layout = prs.slide_layouts[1]
    slide = prs.slides.add_slide(slide_layout)
    title = slide.shapes.title
    body = slide.shapes.placeholders[1]
    title.text = titulo

    texto = texto.replace("\\n", "\n")
    for linea in texto.split("\n"):
        if not linea.strip():
            continue
        p = body.text_frame.add_paragraph()
        p.text = linea.strip()
        p.font.size = Pt(18)
        p.level = 0

    return slide


def agregar_lista_slide(prs, titulo, elementos):
    slide_layout = prs.slide_layouts[1]
    slide = prs.slides.add_slide(slide_layout)
    title = slide.shapes.title
    body = slide.shapes.placeholders[1]
    title.text = titulo

    text_frame = body.text_frame
    text_frame.clear()
    for i, elemento in enumerate(elementos):
        p = text_frame.add_paragraph() if i > 0 else text_frame.paragraphs[0]
        p.text = elemento.strip()
        p.level = 0
        p.font.size = Pt(18)
        p.font.bold = False
    return slide


def agregar_imagen_slide(prs, titulo, imagen_arg, subtitulo=None):
    slide_layout = prs.slide_layouts[6] if len(prs.slide_layouts) > 6 else prs.slide_layouts[5]
    slide = prs.slides.add_slide(slide_layout)
    if titulo:
        if slide.shapes.title:
            slide.shapes.title.text = titulo
        else:
            title = slide.shapes.add_textbox(Inches(0.5), Inches(0.2), Inches(9), Inches(1))
            title.text = titulo

    image_path = imagen_arg
    temp_path = None
    if imagen_arg.startswith("http://") or imagen_arg.startswith("https://"):
        temp_path = descargar_imagen(imagen_arg)
        if temp_path:
            image_path = temp_path
        else:
            # No se pudo descargar la imagen; la presentación sigue sin ella.
            agregar_texto_slide(prs, titulo, "Imagen no disponible: " + imagen_arg)
            return slide

    left = Inches(0.5)
    top = Inches(1.2)
    width = Inches(9)
    try:
        slide.shapes.add_picture(image_path, left, top, width=width)
    except Exception as e:
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)
        agregar_texto_slide(prs, titulo, "Imagen no disponible: " + imagen_arg)
        return slide

    if subtitulo:
        caption_box = slide.shapes.add_textbox(Inches(0.5), Inches(5.5), Inches(9), Inches(1))
        caption_p = caption_box.text_frame.add_paragraph()
        caption_p.text = subtitulo
        caption_p.font.size = Pt(14)

    if temp_path and os.path.exists(temp_path):
        os.unlink(temp_path)

    return slide


def procesar_contenido(prs, contenido):
    contenido = contenido.replace("\\\n", "\n").replace("\\n", "\n")
    lineas = contenido.splitlines()
    current_title = None
    current_subtitle = None
    current_parrafos = []
    current_lista = []

    def limpiar_texto(texto):
        texto = texto.strip()
        texto = re.sub(r"\[NEGRITA\](.*?)\[/NEGRITA\]", r"\1", texto, flags=re.IGNORECASE)
        texto = re.sub(r"^\s*\[[A-ZÁÉÍÓÚÑÜ]+\]\s*", "", texto)
        return texto.strip()

    def flush_parrafos():
        nonlocal current_title, current_subtitle, current_parrafos
        if not current_parrafos:
            return
        texto = "\n\n".join(current_parrafos).strip()
        if texto:
            if current_subtitle:
                texto = current_subtitle + "\n\n" + texto
            agregar_texto_slide(prs, current_title or "", texto)
        current_parrafos = []
        current_subtitle = None

    def flush_lista():
        nonlocal current_title, current_subtitle, current_lista
        if not current_lista:
            return
        agregar_lista_slide(prs, current_title or "Puntos clave", current_lista)
        current_lista = []
        current_subtitle = None

    def flush_slide():
        if current_lista:
            flush_lista()
            return
        flush_parrafos()

    for linea in lineas:
        texto_linea = linea.strip()
        if not texto_linea:
            continue

        titulo = re.match(r"^\s*\[TITULO\]\s*(.*)$", texto_linea, re.IGNORECASE)
        if titulo:
            flush_slide()
            current_title = limpiar_texto(titulo.group(1))
            continue

        subtitulo = re.match(r"^\s*\[SUBTITULO\]\s*(.*)$", texto_linea, re.IGNORECASE)
        if subtitulo:
            current_subtitle = limpiar_texto(subtitulo.group(1))
            continue

        parrafo = re.match(r"^\s*\[PARRAFO\]\s*(.*)$", texto_linea, re.IGNORECASE)
        if parrafo:
            current_parrafos.append(limpiar_texto(parrafo.group(1)))
            continue

        lista = re.match(r"^\s*\[LISTA\]\s*(.*)$", texto_linea, re.IGNORECASE)
        if lista:
            if current_parrafos:
                flush_parrafos()
            elementos = [item.strip() for item in re.split(r"[;,]", lista.group(1)) if item.strip()]
            current_lista.extend([limpiar_texto(item) for item in elementos])
            continue

        imagen = re.match(r"^\s*\[IMAGEN\]\s*(.*)$", texto_linea, re.IGNORECASE)
        if imagen:
            flush_slide()
            imagen_texto = limpiar_texto(imagen.group(1))
            partes = [parte.strip() for parte in imagen_texto.split("|", 1)]
            imagen_url = partes[0] if partes else ""
            caption = partes[1] if len(partes) > 1 else None
            agregar_imagen_slide(prs, current_title or "Imagen", imagen_url, caption)
            current_title = None
            current_subtitle = None
            continue

        salto = re.match(r"^\s*\[SALTO\]\s*$", texto_linea, re.IGNORECASE)
        if salto:
            flush_slide()
            current_title = None
            current_subtitle = None
            continue

        # Fallback: acumular texto suelto en un párrafo
        if texto_linea:
            current_parrafos.append(limpiar_texto(texto_linea))

    flush_slide()


def crear_presentacion(ruta, ruta_contenido, con_portada=False):
    with open(ruta_contenido, "r", encoding="utf-8") as f:
        contenido = f.read()

    prs = Presentation()

    if con_portada:
        crear_portada(prs, titulo="Presentación", subtitulo="Generado por LILA")

    procesar_contenido(prs, contenido)
    os.makedirs(os.path.dirname(ruta) if os.path.dirname(ruta) else ".", exist_ok=True)
    temp_ruta = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pptx", dir=os.path.dirname(ruta) if os.path.dirname(ruta) else ".") as tmp:
            temp_ruta = tmp.name
        prs.save(temp_ruta)
        os.replace(temp_ruta, ruta)
        print(f"[LILA] Presentación guardada: {ruta}")
    except PermissionError:
        if temp_ruta and os.path.exists(temp_ruta):
            os.remove(temp_ruta)
        print(f"[LILA ERROR PPT] Permiso denegado al guardar la presentación: {ruta}")
        raise
    except Exception as e:
        if temp_ruta and os.path.exists(temp_ruta):
            os.remove(temp_ruta)
        print(f"[LILA ERROR PPT] Error al guardar la presentación: {e}")
        raise


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Uso: python crear_ppt.py <ruta_pptx> <ruta_contenido_txt> [portada]")
        sys.exit(1)

    ruta = sys.argv[1]
    ruta_contenido = sys.argv[2]
    con_portada = len(sys.argv) > 3 and sys.argv[3].lower() == "true"
    crear_presentacion(ruta, ruta_contenido, con_portada)
