import pandas as pd
import numpy as np
import chess
from sklearn.linear_model import SGDClassifier
from sklearn.metrics import accuracy_score
from sklearn.model_selection import train_test_split

CSV_PATH = "jemalatakayevaa_fen_moves.csv"
RANDOM_STATE = 42


PIECE_ORDER = [
    chess.PAWN, chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN, chess.KING
]

def fen_to_planes(board: chess.Board) -> np.ndarray:
    
    planes = np.zeros((12, 8, 8), dtype=np.float32)
    chan = 0
    for color in [chess.WHITE, chess.BLACK]:
        for pt in PIECE_ORDER:
            for sq in board.pieces(pt, color):
                r = 7 - chess.square_rank(sq)
                c = chess.square_file(sq)
                planes[chan, r, c] = 1.0
            chan += 1
    return planes.reshape(-1)  # 12*8*8 = 768

def move_features(board: chess.Board, move: chess.Move) -> np.ndarray:
    
    f = np.zeros(64 + 64 + 5, dtype=np.float32)
    f[move.from_square] = 1.0
    f[64 + move.to_square] = 1.0
    promo_map = {None:0, chess.QUEEN:1, chess.ROOK:2, chess.BISHOP:3, chess.KNIGHT:4}
    f[128 + promo_map.get(move.promotion, 0)] = 1.0
    return f  # 133 dims

def make_example(board: chess.Board, move: chess.Move) -> np.ndarray:
   
    b = fen_to_planes(board)
    m = move_features(board, move)
    turn = np.array([1.0 if board.turn == chess.WHITE else 0.0], dtype=np.float32)
    return np.concatenate([b, m, turn]) 

def build_training_pairs(df: pd.DataFrame, negatives_per_pos: int = 7):
    X, y = [], []
    rng = np.random.default_rng(RANDOM_STATE)

    for fen, uci_true in df[["fen", "move_uci"]].itertuples(index=False):
        board = chess.Board(fen)
        legal = list(board.legal_moves)
        if not legal:
            continue

        try:
            true_move = chess.Move.from_uci(uci_true)
        except:
            continue

        if true_move not in board.legal_moves:
            continue

        
        X.append(make_example(board, true_move))
        y.append(1)

       
        others = [m for m in legal if m != true_move]
        if not others:
            continue
        k = min(negatives_per_pos, len(others))
        negs = rng.choice(others, size=k, replace=False)
        for m in negs:
            X.append(make_example(board, m))
            y.append(0)

    return np.vstack(X), np.array(y, dtype=np.int64)

def main():
    df = pd.read_csv(CSV_PATH)
    
    df = df.sample(frac=1.0, random_state=RANDOM_STATE).reset_index(drop=True)

    X, y = build_training_pairs(df, negatives_per_pos=7)
    print("Training pairs:", X.shape, "Positives:", y.sum(), "Negatives:", (y==0).sum())

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=RANDOM_STATE, stratify=y
    )

    clf = SGDClassifier(
        loss="log_loss",
        alpha=1e-5,
        max_iter=20,
        random_state=RANDOM_STATE,
        n_jobs=-1
    )
    clf.fit(X_train, y_train)

    pred = clf.predict(X_test)
    acc = accuracy_score(y_test, pred)
    print("Test accuracy (pairwise):", round(acc, 4))

    
    np.savez("style_model_sgd.npz", coef=clf.coef_.astype(np.float32), intercept=clf.intercept_.astype(np.float32))
    print("Saved: style_model_sgd.npz")

if __name__ == "__main__":
    main()
