"""Write a quick review sheet of SVG snippets and screenshot it with headless Chrome."""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUTDIR = os.environ.get("REVIEW_DIR", tempfile.gettempdir())


def sheet(items, name="review", cols=3, cell=420, bg="#0a0a0a", fg="#ededed"):
    cards = "".join(
        f'<div class="c"><div class="s">{svg}</div><div class="l">{label}</div></div>' for label, svg in items
    )
    rows = (len(items) + cols - 1) // cols
    html = f"""<!doctype html><meta charset=utf-8><style>
    body{{margin:0;background:{bg};color:{fg};font:12px 'Departure Mono',monospace}}
    .g{{display:grid;grid-template-columns:repeat({cols},{cell}px);gap:1px;background:#222}}
    .c{{background:{bg};height:{cell}px;display:flex;flex-direction:column}}
    .s{{flex:1;display:flex;align-items:center;justify-content:center;padding:20px}}
    .s svg{{width:100%;height:100%}} .l{{padding:8px 12px;opacity:.6;letter-spacing:.08em}}
    </style><div class=g>{cards}</div>"""
    path = os.path.join(OUTDIR, f"{name}.html")
    with open(path, "w") as f:
        f.write(html)
    png = os.path.join(OUTDIR, f"{name}.png")
    subprocess.run([os.path.join(HERE, "shot.sh"), path, png, str(cols * (cell + 1)), str(rows * (cell + 1))], check=False)
    return png


if __name__ == "__main__":
    print(sheet([(a, open(a).read()) for a in sys.argv[1:]]))
