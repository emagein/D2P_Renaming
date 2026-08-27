/**
 * TACTICAL CORE LOGIC ENGINE (PDF Renamer & SKU Organizer)
 * Decoupled from UI presentation.
 */

class BatchEngine {
  constructor(callbacks = {}) {
    this.onLog = callbacks.onLog || ((msg, type) => {});
    this.onProgress = callbacks.onProgress || ((g1, g2, g3) => {});
    this.inMemorySkuOverrides = {};
  }

  /* Universal Trigger Download */
  triggerDownload(blob, filename) {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    }, 2000);
  }

  /* In-Memory SKU Rule Overrides */
  setSkuOverride(category, text) {
    this.inMemorySkuOverrides[category] = text;
  }

  getSkuOverride(category) {
    return this.inMemorySkuOverrides[category] || '';
  }

  /* 1. Core PDF Renamer Pipeline (renamer.py) */
  async runRenamer({ pdfFiles, csvFile, simulate = false }) {
    if (!pdfFiles || !pdfFiles.length || !csvFile) {
      throw new Error("Select both target PDF files and a mapping CSV table.");
    }

    this.onLog(`PARSING CSV MAP: ${csvFile.name}`);
    const text = await csvFile.text();
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());

    const skuIdx = headers.indexOf('mapped_sku');
    const bidIdx = headers.indexOf('batch_job_id');

    if (skuIdx === -1 || bidIdx === -1) {
      throw new Error("CSV must contain 'mapped_sku' and 'batch_job_id' column headers.");
    }

    const map = {};
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(',');
      const bid = (row[bidIdx] || '').trim();
      const sku = (row[skuIdx] || '').trim();
      if (bid) map[bid] = sku;
    }

    const zip = new JSZip();
    let renamed = 0, noSku = 0;

    for (let i = 0; i < pdfFiles.length; i++) {
      const file = pdfFiles[i];
      const stem = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;
      const ext = file.name.substring(file.name.lastIndexOf('.'));
      const lookup = stem.includes('-') ? stem.split('-')[0].trim() : stem;

      if (map[lookup]) {
        const newName = `${map[lookup]} ${stem}${ext}`;
        if (!simulate) zip.file(newName, file);
        renamed++;
        this.onLog(`COPY: '${file.name}' -> '${newName}'`);
      } else {
        if (!simulate) zip.folder('NO_SKU').file(file.name, file);
        noSku++;
        this.onLog(`COPY to NO_SKU: '${file.name}'`);
      }

      this.onProgress({
        gauge1: { ratio: renamed / pdfFiles.length, text: `${renamed}/${pdfFiles.length}`, label: 'MATCHED' },
        gauge2: { ratio: (i + 1) / pdfFiles.length, text: `${i + 1}/${pdfFiles.length}`, label: 'PROCESSED' },
        gauge3: { ratio: 1.0, text: '100%', label: 'ACTIVE' }
      });
    }

    if (!simulate) {
      this.onLog("COMPILING ZIP ARCHIVE...");
      const blob = await zip.generateAsync({ type: 'blob' });
      this.triggerDownload(blob, `Renamed_PDF_Export_${Date.now()}.zip`);
    }
    this.onLog(`RENAMER DONE: Copied: ${renamed}, NO_SKU: ${noSku}`, 'success');
  }

  /* 2. Core SKU File Organizer Pipeline (org.py - RB_SKU Removed) */
  async runOrganizer({ targetFiles, skuCategory, customCsvFiles = [], renameCount = true }) {
    if (!targetFiles || !targetFiles.length) {
      throw new Error("Select source files to categorize.");
    }

    let csvMapEntries = [];

    // Check user in-memory editor rules
    if (this.inMemorySkuOverrides[skuCategory] && this.inMemorySkuOverrides[skuCategory].trim()) {
      csvMapEntries.push({ name: skuCategory, content: this.inMemorySkuOverrides[skuCategory] });
    } else if (skuCategory === 'custom') {
      if (!customCsvFiles.length) throw new Error("Upload at least one custom SKU CSV file.");
      for (const file of customCsvFiles) {
        csvMapEntries.push({ name: file.name.replace(/\.csv$/i, ''), content: await file.text() });
      }
    } else {
      // Auto-fetch from GitHub repo
      try {
        const apiRes = await fetch(`https://api.github.com/repos/emagein/D2P_Renaming/contents/SKU/${skuCategory}`);
        if (apiRes.ok) {
          const files = await apiRes.json();
          for (const f of files) {
            if (f.name.endsWith('.csv')) {
              const res = await fetch(f.download_url);
              csvMapEntries.push({ name: f.name.replace(/\.csv$/i, ''), content: await res.text() });
            }
          }
        }
      } catch (e) {}

      if (!csvMapEntries.length) {
        throw new Error(`No CSV records found for ${skuCategory}. Click 'VIEW / ADD / EDIT SKU RULES' to enter rules manually.`);
      }
    }

    const zip = new JSZip();
    const filesArr = Array.from(targetFiles);
    const moved = new Set();
    let totalMoved = 0;

    for (let i = 0; i < csvMapEntries.length; i++) {
      const { name, content } = csvMapEntries[i];
      const skus = new Set(content.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean));
      const matchedFiles = [];

      for (const file of filesArr) {
        if (moved.has(file.name)) continue;
        const stem = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;

        let matched = false;
        if (skus.has(stem)) matched = true;
        else if (stem.includes(' ') && skus.has(stem.split(' ')[0])) matched = true;
        else if (stem.includes('_') && skus.has(stem.split('_')[0])) matched = true;
        else {
          for (const sku of skus) {
            if (stem.startsWith(sku)) { matched = true; break; }
          }
        }

        if (matched) {
          matchedFiles.push(file);
          moved.add(file.name);
          totalMoved++;
          this.onLog(`ORGANIZED [${name}]: ${file.name}`);
        }
      }

      if (matchedFiles.length > 0) {
        const folderName = renameCount ? `${name}_${matchedFiles.length}` : name;
        const targetDir = zip.folder(folderName);
        matchedFiles.forEach(f => targetDir.file(f.name, f));
      }

      this.onProgress({
        gauge2: { ratio: (i + 1) / csvMapEntries.length, text: `${i + 1}/${csvMapEntries.length}`, label: 'LISTS' }
      });
    }

    this.onProgress({
      gauge1: { ratio: totalMoved / filesArr.length, text: `${totalMoved}/${filesArr.length}`, label: 'MATCHED' },
      gauge3: { ratio: 1.0, text: '100%', label: 'COMPLETE' }
    });

    if (totalMoved > 0) {
      const blob = await zip.generateAsync({ type: 'blob' });
      this.triggerDownload(blob, `Organized_${skuCategory}_${totalMoved}.zip`);
      this.onLog(`DONE: Organized ${totalMoved} files across ${csvMapEntries.length} categories.`, 'success');
    } else {
      this.onLog("No matching files found for active SKU rules.", 'warn');
    }
  }
}

window.BatchEngine = BatchEngine;
