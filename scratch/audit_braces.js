const fs = require('fs');
const content = fs.readFileSync('main.js', 'utf8');
let braces = 0;
let parens = 0;
let brackets = 0;
let inString = null;
let escaped = false;

const stack = [];
for (let i = 0; i < content.length; i++) {
  const c = content[i];
  if (escaped) {
    escaped = false;
    continue;
  }
  if (c === '\\') {
    escaped = true;
    continue;
  }
  if (inString) {
    if (c === inString) inString = null;
    if (inString === '`' && c === '$' && content[i+1] === '{') {
      stack.push({ type: 'interpolation', pos: i, line: content.substring(0, i).split('\n').length });
      i++;
    }
    continue;
  }
  if (c === '"' || c === "'" || c === '`') {
    inString = c;
    continue;
  }
  if (c === '{' || c === '(' || c === '[') {
    stack.push({ type: c, pos: i, line: content.substring(0, i).split('\n').length });
  }
  if (c === '}' || c === ')' || c === ']') {
    const last = stack.pop();
    const expected = { '}': '{', ')': '(', ']': '[' }[c];
    if (last && last.type === 'interpolation' && c === '}') {
      // interpolation closed
    } else if (!last || last.type !== expected) {
      console.log(`Mismatched ${c} at line ${content.substring(0, i).split('\n').length}`);
    }
  }
}

console.log('Unclosed:', stack);

