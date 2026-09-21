"""Lance Souffle : python run.py  (puis ouvre http://127.0.0.1:8000)."""
import argparse
import threading
import webbrowser

import uvicorn


def main() -> None:
    ap = argparse.ArgumentParser(description="Tableau de bord Souffle")
    ap.add_argument("--host", default="127.0.0.1", help="Adresse d'écoute (0.0.0.0 pour l'ouvrir au réseau local)")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true", help="Ne pas ouvrir le navigateur")
    args = ap.parse_args()

    if not args.no_browser:
        url = f"http://{'127.0.0.1' if args.host == '0.0.0.0' else args.host}:{args.port}"
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()

    # Un seul processus : l'état des sessions est conservé en mémoire.
    uvicorn.run("app.main:app", host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
