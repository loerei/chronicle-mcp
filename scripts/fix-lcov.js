import fs from 'fs';
import path from 'path';

const lcovPath = path.join(process.cwd(), 'coverage', 'lcov.info');

if (!fs.existsSync(lcovPath)) {
  console.error(`LCOV file not found at: ${lcovPath}`);
  process.exit(1);
}

let content = fs.readFileSync(lcovPath, 'utf8');

// Replace path separators and source directories
content = content.split('\n').map(line => {
  if (line.startsWith('SF:')) {
    // SF:dist\adapters\Antigravity.js -> SF:src/adapters/Antigravity.ts
    let filePath = line.slice(3).trim();
    filePath = filePath.replace(/\\/g, '/');
    filePath = filePath.replace(/^dist\//, 'src/');
    if (filePath.endsWith('.js')) {
      filePath = filePath.slice(0, -3) + '.ts';
    }
    return `SF:${filePath}`;
  }
  return line;
}).join('\n');

fs.writeFileSync(lcovPath, content, 'utf8');
console.log('Successfully fixed LCOV file paths for SonarCloud.');
