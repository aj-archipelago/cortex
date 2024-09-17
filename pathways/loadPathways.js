import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Function to load pathways from a JSON file
const loadPathways = (filePath) => {
  const data = fs.readFileSync(filePath, 'utf8');
  const pathways = JSON.parse(data);
  return pathways;
};

export default loadPathways;