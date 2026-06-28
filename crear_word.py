# crear_word.py — Crea documentos Word con formato completo
# Uso: python crear_word.py "ruta.docx" "ruta_contenido.txt" "true/false"

import sys
import os
import re  # <--- IMPORTANTE: Importamos librería de expresiones regulares
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH

def agregar_portada(doc):
    doc.add_paragraph()
    doc.add_paragraph()
    doc.add_paragraph()

    titulo = doc.add_paragraph()
    titulo.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = titulo.add_run("Presentación")
    run.bold = True
    run.font.size = Pt(24)

    doc.add_paragraph()
    doc.add_paragraph()

    campos = ["Centro educativo", "Asignatura", "Tema", "Profesor/a", "Nombre", "Área", "Fecha"]
    for campo in campos:
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = p.add_run(campo)
        run.bold = True
        run.font.size = Pt(12)
        doc.add_paragraph()

    doc.add_page_break()

# ─── NUEVA FUNCIÓN PARA PROCESAR NEGRITAS INTERNAS ──────────────────────────
def agregar_texto_con_formato(parrafo, texto):
    # Buscamos todo lo que esté entre [NEGRITA] y [/NEGRITA]
    patron = r'\[NEGRITA\](.*?)\[/NEGRITA\]'
    
    ultimo_indice = 0
    for match in re.finditer(patron, texto):
        # 1. Agregamos el texto normal ANTES de la etiqueta
        if match.start() > ultimo_indice:
            run_normal = parrafo.add_run(texto[ultimo_indice:match.start()])
            run_normal.font.size = Pt(12)
        
        # 2. Agregamos el texto resaltado CON negrita
        texto_negrita = match.group(1)
        run_bold = parrafo.add_run(texto_negrita)
        run_bold.bold = True
        run_bold.font.size = Pt(12)
        
        ultimo_indice = match.end()
        
    # 3. Agregamos cualquier texto normal que sobre al final
    if ultimo_indice < len(texto):
        run_final = parrafo.add_run(texto[ultimo_indice:])
        run_final.font.size = Pt(12)
# ────────────────────────────────────────────────────────────────────────────

def procesar_contenido(doc, contenido):
    # Limpiar backslashes al final de linea que manda Gemini
    contenido = contenido.replace("\\\n", "\n").replace("\\n", "\n")
    lineas = contenido.split("\n")

    for linea in lineas:
        linea = linea.strip()
        if not linea:
            doc.add_paragraph()
            continue

        if linea.startswith("[TITULO]"):
            texto = linea.replace("[TITULO]", "").strip()
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            run = p.add_run(texto)
            run.bold = True
            run.font.size = Pt(18)
            doc.add_paragraph()

        elif linea.startswith("[SUBTITULO]"):
            texto = linea.replace("[SUBTITULO]", "").strip()
            p = doc.add_paragraph()
            run = p.add_run(texto)
            run.bold = True
            run.font.size = Pt(14)

        elif linea.startswith("[PARRAFO]"):
            texto = linea.replace("[PARRAFO]", "").strip()
            p = doc.add_paragraph() # Creamos el párrafo vacío
            p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
            p.paragraph_format.first_line_indent = Cm(1.25)
            # Usamos la nueva función para rellenarlo
            agregar_texto_con_formato(p, texto)

        elif linea.startswith("[LISTA]"):
            texto = linea.replace("[LISTA]", "").strip()
            p = doc.add_paragraph(style="List Bullet") # Creamos la viñeta vacía
            # Usamos la nueva función para rellenarlo
            agregar_texto_con_formato(p, texto)

        elif linea.startswith("[SALTO]"):
            doc.add_page_break()

        else:
            # Ignorar lineas que sean solo etiquetas del sistema
            if linea.startswith("[SISTEMA:") or linea == "\\":
                continue
            
            # Para cualquier otra línea sin etiqueta, también aplicamos el formato por si acaso
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
            agregar_texto_con_formato(p, linea)

def crear_documento(ruta, ruta_contenido, con_portada=False):
    # Leer contenido desde archivo temporal
    with open(ruta_contenido, "r", encoding="utf-8") as f:
        contenido = f.read()

    doc = Document()

    for section in doc.sections:
        section.top_margin    = Cm(2.5)
        section.bottom_margin = Cm(2.5)
        section.left_margin   = Cm(3)
        section.right_margin  = Cm(2.5)

    style = doc.styles["Normal"]
    style.font.name = "Times New Roman"
    style.font.size = Pt(12)

    if con_portada:
        agregar_portada(doc)

    procesar_contenido(doc, contenido)

    os.makedirs(os.path.dirname(ruta) if os.path.dirname(ruta) else ".", exist_ok=True)
    doc.save(ruta)
    print(f"[LILA] Documento guardado: {ruta}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Uso: python crear_word.py <ruta_docx> <ruta_contenido_txt> [portada]")
        sys.exit(1)

    ruta            = sys.argv[1]
    ruta_contenido  = sys.argv[2]
    con_portada     = len(sys.argv) > 3 and sys.argv[3].lower() == "true"
    crear_documento(ruta, ruta_contenido, con_portada)