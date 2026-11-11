import { describe, expect, it } from 'vitest';
import { displayCommand, relativeTo } from './format';

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
