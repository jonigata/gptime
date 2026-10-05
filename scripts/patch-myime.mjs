import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(process.argv[2] || 'upstream/myime');
const target = join(root, 'mozc/src/converter/azookey_immutable_converter.cc');
let source = await readFile(target, 'utf8');
function replaceOnce(before, after) {
  if (source.split(before).length !== 2) throw new Error('対応するMyIMEソースではありません。変更を適用せず終了します。');
  source = source.replace(before, after);
}
if (!source.includes('// GPTIME: explicit conversions only.')) {
  replaceOnce('  ConvertTextFunc ConvertText = nullptr;',
    '  ConvertTextFunc ConvertText = nullptr;\n  ConvertTextFunc ConvertTextWithLuna = nullptr;');
  replaceOnce('        GetProcAddress(dll_handle_, "ConvertText"));',
    '        GetProcAddress(dll_handle_, "ConvertText"));\n    ConvertTextWithLuna = reinterpret_cast<ConvertTextFunc>(\n        GetProcAddress(dll_handle_, "ConvertTextWithLuna"));');
  replaceOnce('    ConvertText = nullptr;', '    ConvertText = nullptr;\n    ConvertTextWithLuna = nullptr;');
  replaceOnce('    const char* candidates_json = loader.ConvertText(key.c_str(), allow_learning);',
    `    // GPTIME: explicit conversions only. No network for prediction/private input.
    const bool use_luna = allow_learning && !IsHermeticTestMode() &&
        options.request_type == RequestType::CONVERSION &&
        !options.used_in_predictor_realtime_conversion && !options.idle_resuggest;
    const auto convert = use_luna && loader.ConvertTextWithLuna
        ? loader.ConvertTextWithLuna : loader.ConvertText;
    const char* candidates_json = convert(key.c_str(), allow_learning);`);
  // All anchors were checked before the first write.
  await writeFile(target, source);
}
await copyFile(new URL('../integrations/myime/GptimeBridge.swift', import.meta.url),
  join(root, 'src/swift-engine/Sources/azookey-engine/GptimeBridge.swift'));
console.log(`GPTIME連携を適用しました: ${root}`);
