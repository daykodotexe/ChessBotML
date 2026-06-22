import csv 
import io 
import time
import requests
import chess
import chess.pgn

USERNAME = "jemalatakayevaa"
TIME_CLASS = {"blitz", "rapid"}
OUT_CSV = "jemalatakayevaa_fen_moves.csv"

def get_json(url: str, retries: int = 3, sleep_s: float = 1.0):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) chess-bot-dataset/1.0",
        "Accept": "application/json",
    }
    for i in range(retries):
        r = requests.get(url, headers=headers, timeout=30)
        if r.status_code == 200:
            return r.json()

    
        if r.status_code in (403, 429):
            time.sleep(sleep_s * (i + 1) * 3)
        else:
            time.sleep(sleep_s * (i + 1))

    r.raise_for_status()


def iter_games_pgn_from_month(month_url_json: str):
    data = get_json(month_url_json)
    for g in data.get("games", []):
        if g.get("time_class") in TIME_CLASS:
            yield g.get("pgn")

def pgn_to_training_rows(pgn_text: str, username: str):
    rows = []
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        return rows
    
    white = (game.headers.get("White") or "").lower()
    black = (game.headers.get("Black") or "").lower()
    me_white = (white == username.lower())
    me_black = (black == username.lower())
    if not (me_white or me_black):
        return rows
    
    board = game.board()
    for move in game.mainline_moves():
        if (board.turn == chess.WHITE and me_white) or (board.turn == chess.BLACK and me_black):
            fen = board.fen()
            uci = move.uci()
            rows.append((fen, uci))
        board.push(move)

    return rows

def main():
    archives_url = f"https://api.chess.com/pub/player/{USERNAME}/games/archives"
    archives = get_json(archives_url).get("archives", [])
    
    with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["fen", "move_uci"])

        total_rows = 0
        for month_url in archives:
            for pgn in iter_games_pgn_from_month(month_url):
                rows = pgn_to_training_rows(pgn, USERNAME)
                for row in rows:
                    w.writerow(row)
                total_rows += len(rows)

            time.sleep(0.3)
        print(f"Saved {total_rows} rows to {OUT_CSV}")

if __name__ == "__main__":
    main()