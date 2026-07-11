# -*- coding: utf-8 -*-
"""Generate app/js/prompts.builtin.js from extracted prompts.
Runs once for v1.1.0 F2. The gen-supervisors.py script will be updated
to output here as well for future regeneration.
"""
import base64, io, json, os, re, subprocess

os.chdir(os.path.dirname(os.path.abspath(__file__)) + '/..')

# Read prompts from supervisors.js
with io.open('app/js/supervisors.js', encoding='utf-8') as f:
    content = f.read()

# Extract the three prompt template literals
cangjie_match = re.search(r'const CANGJIE_PROMPT = `(.+?)`;\s*\n\s*//', content, re.DOTALL)
if not cangjie_match:
    raise RuntimeError('Cannot extract CANGJIE_PROMPT')
cangjie = cangjie_match.group(1)

nvwa_match = re.search(r'const NVWA_PROMPT = `(.+?)`;\s*\n\s*//', content, re.DOTALL)
if not nvwa_match:
    raise RuntimeError('Cannot extract NVWA_PROMPT')
nvwa = nvwa_match.group(1)

winnicott_match = re.search(r'const WINNICOTT_PROMPT = `(.+?)`;\s*\n\s*//', content, re.DOTALL)
if not winnicott_match:
    raise RuntimeError('Cannot extract WINNICOTT_PROMPT')
winnicott = winnicott_match.group(1)

# Extract STYLE_CONSTRAINTS and WINNICOTT_PERSONA_GUARD arrays
style_match = re.search(r'const STYLE_CONSTRAINTS = (\[.*?\])\.join', content, re.DOTALL)
style_arr = style_match.group(1) if style_match else '[]'

guard_match = re.search(r'const WINNICOTT_PERSONA_GUARD = (\[.*?\])\.join', content, re.DOTALL)
guard_arr = guard_match.group(1) if guard_match else '[]'

def b64(s):
    return base64.b64encode(s.encode('utf-8')).decode('ascii')

# Build prompts.builtin.js
js = []
js.append('/** @internal \u5185\u7f6e\u7763\u5bfc\u5e08\u65b9\u6cd5\u8bba\u63d0\u793a\u8bcd \u2014 \u4e0d\u53ef\u5bf9\u7528\u6237\u53ef\u89c1')
js.append(' * \u6b64\u6587\u4ef6\u7531 scripts/gen-prompts-builtin.py \u751f\u6210\u3002')
js.append(' * \u5185\u5bb9\u4e3a Base64 \u7f16\u7801\u7684\u63d0\u793a\u8bcd\u5e38\u91cf\uff0c\u8fd0\u884c\u65f6\u7531 Supervisors \u6a21\u5757\u89e3\u7801\u4f7f\u7528\u3002')
js.append(' * \u6ce8\u610f\uff1aBase64 \u4ec5\u62ac\u9ad8\u95e8\u69db\u3001\u975e\u52a0\u5bc6\u3002\u771f\u6b63\u7684\u4fdd\u62a4\u662f UI \u4e0d\u5c55\u793a + \u79cd\u5b50\u4e0d\u5b58\u660e\u6587\u3002')
js.append(' */')
js.append('')
js.append("const PromptsBuiltin = (() => {")
js.append("  'use strict';")
js.append('')
js.append('  // Base64 \u89e3\u7801\uff08\u652f\u6301 UTF-8 \u591a\u5b57\u8282\uff09')
js.append('  function d(b64) {')
js.append('    const bin = atob(b64);')
js.append("    const bytes = new Uint8Array(bin.length);")
js.append('    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xFF;')
js.append('    return new TextDecoder(\"utf-8\").decode(bytes);')
js.append('  }')
js.append('')
js.append('  // \u4ed3\u9888\u7248\u65b9\u6cd5\u8bba\u63d0\u793a\u8bcd')
js.append('  const CANGJIE_B64 = "' + b64(cangjie) + '";')
js.append('')
js.append('  // \u5973\u5a32\u7248\u65b9\u6cd5\u8bba\u63d0\u793a\u8bcd')
js.append('  const NVWA_B64 = "' + b64(nvwa) + '";')
js.append('')
js.append('  // \u65e7\u7248\u5355\u4e00\u6e29\u5c3c\u79d1\u7279\u63d0\u793a\u8bcd\uff08\u5411\u540e\u517c\u5bb9 session.js \u4e0b\u62c9\u9ed8\u8ba4\u9879\uff09')
js.append('  const WINNICOTT_B64 = "' + b64(winnicott) + '";')
js.append('')
js.append('  // \u8868\u8fbe\u98ce\u683c\u7ea6\u675f\uff08\u4e0e chat \u540c\u6e90\uff0c\u975e\u673a\u5bc6\u2014\u2014\u660e\u6587\u5b58\u653e\uff09')
js.append('  const STYLE_CONSTRAINTS = ' + style_arr + ".join('\\n');")
js.append('')
js.append('  // \u8eab\u4efd guard\uff08\u4e0e chat \u540c\u6e90\uff0c\u975e\u673a\u5bc6\u2014\u2014\u660e\u6587\u5b58\u653e\uff09')
js.append('  const WINNICOTT_PERSONA_GUARD = ' + guard_arr + ".join('\\n');")
js.append('')
js.append('  return {')
js.append('    getCangjiePrompt: () => d(CANGJIE_B64),')
js.append('    getNvwaPrompt: () => d(NVWA_B64),')
js.append('    getWinnicottPrompt: () => d(WINNICOTT_B64),')
js.append('    STYLE_CONSTRAINTS,')
js.append('    WINNICOTT_PERSONA_GUARD,')
js.append('  };')
js.append('})();')
js.append('')
js.append('if (typeof window !== "undefined") {')
js.append('  window.PromptsBuiltin = PromptsBuiltin;')
js.append('}')
js.append('')

result = '\n'.join(js) + '\n'
with io.open('app/js/prompts.builtin.js', 'w', encoding='utf-8') as f:
    f.write(result)
print('WRITTEN app/js/prompts.builtin.js bytes=', os.path.getsize('app/js/prompts.builtin.js'))

# Verify decode works
r = subprocess.run(['node', '-e', '''
const fs = require("fs");
eval(fs.readFileSync("app/js/prompts.builtin.js", "utf-8"));
const c = PromptsBuiltin.getCangjiePrompt();
const n = PromptsBuiltin.getNvwaPrompt();
const w = PromptsBuiltin.getWinnicottPrompt();
console.log("cangjie decoded length:", c.length);
console.log("nvwa decoded length:", n.length);
console.log("winnicott decoded length:", w.length);
console.log("style constraints:", PromptsBuiltin.STYLE_CONSTRAINTS.length, "chars");
console.log("persona guard:", PromptsBuiltin.WINNICOTT_PERSONA_GUARD.length, "chars");
'''], capture_output=True, text=True)
print(r.stdout)
if r.stderr:
    print('STDERR:', r.stderr)
    raise RuntimeError('Node verification failed')
