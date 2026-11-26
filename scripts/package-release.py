from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
output = root / "dist" / "minimal-text-ai.zip"
output.parent.mkdir(exist_ok=True)

with TemporaryDirectory(dir=output.parent) as staging:
    archive = Path(staging) / output.name
    with ZipFile(archive, "w", ZIP_DEFLATED) as package:
        for name in ("main.js", "manifest.json", "styles.css", "LICENSE", "THIRD-PARTY-LICENSES.txt"):
            package.write(root / name, f"minimal-text-ai/{name}")
    archive.replace(output)

print(f"Created {output.relative_to(root)}")
