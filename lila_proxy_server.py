import json
import os
import urllib.request
import urllib.error
from typing import Any, Dict, List, Optional

from fastapi import FastAPI
from pydantic import BaseModel

# Coloca tus claves en variables de entorno antes de ejecutar el servidor.
# Windows PowerShell: $env:GEMINI_API_KEY="tu_clave"
# Windows CMD: set GEMINI_API_KEY=tu_clave
# Linux/macOS: export GEMINI_API_KEY="tu_clave"
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")

app = FastAPI(title="LILA Smart API Proxy", version="1.0.0")
provider_rotation_index = 0


class ChatRequest(BaseModel):
    messages: List[Any]


class ChatResponse(BaseModel):
    reply: str
    provider: str
    used_fallback: bool


PROVIDERS: List[Dict[str, Any]] = [
    {
        "name": "gemini",
        "env_var": "GEMINI_API_KEY",
        "api_key": GEMINI_API_KEY,
        "endpoint": "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
        "payload_builder": lambda prompt: {
            "contents": [{"parts": [{"text": prompt}]}],
        },
        "response_parser": lambda payload: payload.get("candidates", [{}])[0]
        .get("content", {})
        .get("parts", [{}])[0]
        .get("text", ""),
    },
    {
        "name": "groq",
        "env_var": "GROQ_API_KEY",
        "api_key": GROQ_API_KEY,
        "endpoint": "https://api.groq.com/openai/v1/chat/completions",
        "payload_builder": lambda prompt: {
            "model": "llama3-8b-8192",
            "messages": [{"role": "user", "content": prompt}],
        },
        "response_parser": lambda payload: payload.get("choices", [{}])[0]
        .get("message", {})
        .get("content", ""),
    },
    {
        "name": "deepseek",
        "env_var": "DEEPSEEK_API_KEY",
        "api_key": DEEPSEEK_API_KEY,
        "endpoint": "https://api.deepseek.com/chat/completions",
        "payload_builder": lambda prompt: {
            "model": "deepseek-chat",
            "messages": [{"role": "user", "content": prompt}],
        },
        "response_parser": lambda payload: payload.get("choices", [{}])[0]
        .get("message", {})
        .get("content", ""),
    },
]


def get_provider_list() -> List[Dict[str, Any]]:
    return [
        {
            **provider,
            "api_key": os.getenv(provider["env_var"], ""),
        }
        for provider in PROVIDERS
    ]


def get_next_provider() -> Dict[str, Any]:
    global provider_rotation_index
    providers = get_provider_list()
    if not providers:
        return {"name": "fallback", "api_key": "", "endpoint": "", "payload_builder": lambda prompt: {}, "response_parser": lambda payload: ""}

    provider = providers[provider_rotation_index % len(providers)]
    provider_rotation_index += 1
    return provider


def _extract_text(messages: List[Any]) -> str:
    if not messages:
        return "Hola desde LILA."

    parts: List[str] = []
    for item in messages:
        if isinstance(item, str):
            parts.append(item)
        elif isinstance(item, dict):
            content = item.get("content")
            if isinstance(content, list):
                parts.append(" ".join(str(x) for x in content))
            elif isinstance(content, str):
                parts.append(content)
            else:
                parts.append(str(item))
        else:
            parts.append(str(item))
    return "\n".join(parts).strip() or "Hola desde LILA."


def _call_provider(provider: Dict[str, Any], prompt: str) -> Dict[str, Any]:
    api_key = (provider.get("api_key") or "").strip()
    if not api_key:
        return {
            "ok": False,
            "error": f"No API key configured for {provider['name']}",
            "reply": f"La clave de {provider['name']} no está configurada. Añádela en la variable de entorno {provider['env_var']} antes de usar el proxy.",
        }

    headers = {"Content-Type": "application/json"}
    if provider["name"] == "gemini":
        headers["x-goog-api-key"] = api_key
        payload = provider["payload_builder"](prompt)
    else:
        headers["Authorization"] = f"Bearer {api_key}"
        payload = provider["payload_builder"](prompt)

    req = urllib.request.Request(
        provider["endpoint"],
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            body = response.read().decode("utf-8")
            parsed = json.loads(body) if body else {}
            reply = provider["response_parser"](parsed)
            if isinstance(reply, str) and reply.strip():
                return {"ok": True, "reply": reply.strip(), "provider": provider["name"]}
            return {
                "ok": False,
                "error": "Respuesta vacía del proveedor",
                "reply": f"El proveedor {provider['name']} devolvió una respuesta vacía.",
            }
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="ignore")
        return {
            "ok": False,
            "error": f"HTTP {exc.code}",
            "reply": f"El proveedor {provider['name']} rechazó la solicitud: {error_body}",
        }
    except Exception as exc:  # pragma: no cover - defensive fallback
        return {
            "ok": False,
            "error": str(exc),
            "reply": f"No se pudo contactar con {provider['name']}: {exc}",
        }


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"status": "ok", "providers": [provider["name"] for provider in get_provider_list()]}


@app.post("/chat", response_model=ChatResponse)
def chat(request: ChatRequest) -> ChatResponse:
    prompt = _extract_text(request.messages)
    provider = get_next_provider()
    result = _call_provider(provider, prompt)

    if result.get("ok"):
        return ChatResponse(reply=result["reply"], provider=provider["name"], used_fallback=False)

    return ChatResponse(reply=result["reply"], provider=provider["name"], used_fallback=True)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("lila_proxy_server:app", host="0.0.0.0", port=8000, reload=False)
