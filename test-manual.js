// Manual test script to verify PDF.js loading and outline extraction
import { extractOutline } from './src/shared/outline.js';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

(async () => {
  try {
    console.log('Testing outline extraction...');
    const pdfPath = path.join(__dirname, 'tests/fixtures/nist-outline.pdf');
    console.log('Loading PDF:', pdfPath);
    
    const data = await readFile(pdfPath);
    console.log('PDF loaded, size:', data.length, 'bytes');
    
    const outline = await extractOutline(data);
    console.log('Outline extracted:', outline.length, 'items');
    
    if (outline.length > 0) {
      console.log('\nFirst 5 outline items:');
      outline.slice(0, 5).forEach((item, i) => {
        console.log(`  ${i + 1}. "${item.title}" -> Page ${item.pageIndex + 1} (Level ${item.level})`);
      });
    } else {
      console.log('No outline items found!');
    }
    
    console.log('\n✅ Test completed successfully');
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
})();
