"""Draw the code-native board mark; the generated ICO is checked into source."""
from pathlib import Path
from PIL import Image, ImageDraw

image = Image.new('RGBA', (256,256))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((0,0,255,255), radius=64, fill='#1c5344')
for point in (80,128,176):
    draw.line((48,point,208,point), fill='#b9c9b6', width=3)
    draw.line((point,48,point,208), fill='#b9c9b6', width=3)
draw.ellipse((88,88,168,168), fill='#f7f3e7')
image.save(Path(__file__).resolve().parents[1]/'apps/desktop/icon.ico', format='ICO', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
