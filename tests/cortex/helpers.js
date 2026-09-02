import fs from 'fs';
import os from 'os';
import path from 'path';

// Each test gets a throwaway HOME so real ~/.claude etc. are never touched.
export function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-test-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CORTEX_HOME = path.join(home, '.cortex');
  return home;
}

export function writeSkill(dir, name, description = `${name} description`) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\nBody of ${name}.\n`);
  return path.join(dir, name);
}
