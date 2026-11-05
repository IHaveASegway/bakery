import { contractsDir, write } from './contracts-lib.mjs';

const files = await write(contractsDir);
console.log(`wrote ${files.length} files to src/contracts/: ${files.join(', ')}`);
