import unittest, subprocess, tempfile, json, hashlib
from pathlib import Path
from PIL import Image
ROOT=Path(__file__).resolve().parents[2]
class Branding(unittest.TestCase):
 def test_official_sources_and_native_formats(self):
  with tempfile.TemporaryDirectory() as tmp:
   subprocess.run(['python',str(ROOT/'scripts/generate-installer-branding.py'),'--output',tmp],check=True,capture_output=True)
   m=json.loads((Path(tmp)/'branding-manifest.json').read_text(encoding='utf-8'))
   self.assertEqual(set(m['sources']),{'02_CyberSafe_simbolo.png','07_CyberSafe_horizontal_lockup.png'})
   for name,digest in m['sources'].items():
    self.assertEqual(digest,hashlib.sha256((ROOT/'assets/branding/source'/name).read_bytes()).hexdigest())
   for name,size in [('page-welcome.bmp',(503,287)),('page-config.bmp',(503,287)),('installerHeader.bmp',(150,57)),('installerSidebar.bmp',(164,314)),('uninstallerSidebar.bmp',(164,314))]:
    im=Image.open(Path(tmp)/name);self.assertEqual(im.size,size);self.assertEqual(im.mode,'RGB')
    self.assertEqual(im.getpixel((size[0]-1,size[1]-1)),(7,21,26))
   self.assertEqual(Image.open(Path(tmp)/'preview.bmp').size,(900,560))
if __name__=='__main__': unittest.main()
