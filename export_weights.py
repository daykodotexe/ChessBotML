import numpy as np, json
w = np.load("style_model_sgd.npz")
coef = w["coef"][0].tolist()
intercept = float(w["intercept"][0])
json.dump({"coef": coef, "intercept": intercept}, open("style_model.json","w"))
print("Wrote style_model.json")