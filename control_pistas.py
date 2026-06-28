import sys
import time
import ctypes

# Constantes de teclas multimedia de Windows (Virtual Key Codes)
VK_MEDIA_NEXT_TRACK = 0xB0  # Código para Siguiente
VK_MEDIA_PREV_TRACK = 0xB1  # Código para Anterior

def mandar_pulso(codigo_tecla):
    # Envía el pulso directo a la API de hardware de Windows (user32) de forma nativa e invisible
    ctypes.windll.user32.keybd_event(codigo_tecla, 0, 0, 0) # Presionar
    ctypes.windll.user32.keybd_event(codigo_tecla, 0, 2, 0) # Soltar

if len(sys.argv) > 1:
    comando = sys.argv[1]
    
    if comando == "next":
        mandar_pulso(VK_MEDIA_NEXT_TRACK)
        
    elif comando == "restart":
        mandar_pulso(VK_MEDIA_PREV_TRACK)
        
    elif comando == "prev":
        # Para ir a la anterior real: doble pulso con una pequeña pausa intermedia
        mandar_pulso(VK_MEDIA_PREV_TRACK)
        time.sleep(0.2)
        mandar_pulso(VK_MEDIA_PREV_TRACK)