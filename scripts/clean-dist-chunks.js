const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '../dist');

if (fs.existsSync(distDir)) {
  const files = fs.readdirSync(distDir);
  let deletedCount = 0;
  for (const file of files) {
    if (
      file.startsWith('chunk-') ||
      file.startsWith('explainTab-') ||
      file.startsWith('analystTab-') ||
      file.startsWith('chartTab-') ||
      file.startsWith('ExplainVisualizer-') ||
      file.startsWith('ExplainRecommendationsPanel-') ||
      file.startsWith('PlanDiffEngine-') ||
      file.startsWith('FlameGraphRenderer-') ||
      file.startsWith('deepPlanAnalysis-')
    ) {
      const filePath = path.join(distDir, file);
      try {
        fs.unlinkSync(filePath);
        deletedCount++;
      } catch (err) {
        console.error(`Failed to delete stale chunk ${file}:`, err);
      }
    }
  }
  if (deletedCount > 0) {
    console.log(`[cleanup] Deleted ${deletedCount} stale chunk files from dist/`);
  }
}
