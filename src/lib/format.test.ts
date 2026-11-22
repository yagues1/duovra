import { describe, expect, it } from 'vitest';
import { displayCommand, fmtShortRelative, relativeTo } from './format';

describe('displayCommand', () => {
  it('extrae el comando del envoltorio de PowerShell de Codex', () => {
    // Codex informa las barras invertidas duplicadas en la ruta del ejecutable.
    const raw = `"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command 'Get-Content -LiteralPath math.js; Write-Output ''hola'''`;
    expect(displayCommand(raw)).toBe("Get-Content -LiteralPath math.js; Write-Output 'hola'");
  });
  it('admite la forma con comillas dobles', () => {
    const raw = `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Set-Content -LiteralPath nota2.txt -Value 'adios'"`;
    expect(displayCommand(raw)).toBe("Set-Content -LiteralPath nota2.txt -Value 'adios'");
  });
  it('deja intactos los comandos normales', () => {
    expect(displayCommand('npm test')).toBe('npm test');
  });
});

describe('relativeTo', () => {
  it('muestra rutas relativas al proyecto', () => {
    expect(relativeTo('C:\\p\\src\\a.ts', 'C:\\p')).toBe('src/a.ts');
    expect(relativeTo('D:\\otro\\a.ts', 'C:\\p')).toBe('D:\\otro\\a.ts');
  });
});

describe('fmtShortRelative', () => {
  it('abrevia la hora relativa para la barra lateral', () => {
    const now = 1_800_000_000_000;
    expect(fmtShortRelative(now - 20_000, now)).toBe('ahora');
    expect(fmtShortRelative(now - 3 * 60_000, now)).toBe('3 min');
    expect(fmtShortRelative(now - 2 * 3_600_000, now)).toBe('2 h');
    expect(fmtShortRelative(now - 26 * 3_600_000, now)).toBe('ayer');
    expect(fmtShortRelative(now - 4 * 86_400_000, now)).toBe('4 d');
  });
});
