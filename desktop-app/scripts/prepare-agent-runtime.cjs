const fs = require("fs");
const path = require("path");

const desktopAppDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopAppDir, "..");
const printAgentDir = path.join(repoRoot, "print-agent");
const runtimeDestDir = path.join(desktopAppDir, "agent-runtime");
const runtimePythonDest = path.join(runtimeDestDir, "python");

function parsePyVenvCfg(venvDir) {
  const cfgPath = path.join(venvDir, "pyvenv.cfg");
  if (!fs.existsSync(cfgPath)) return null;
  const lines = fs.readFileSync(cfgPath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^home\s*=\s*(.+)$/i);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

function copyDirFiltered(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const name = entry.name;
    if (
      name === "__pycache__" ||
      name.endsWith(".pyc") ||
      name.startsWith(".env") ||
      name === "completed_jobs.json" ||
      name.endsWith(".log") ||
      name === "test" ||
      name === "tests" ||
      name === "idlelib" ||
      name === "tkinter" ||
      name === "turtledemo" ||
      name === "ensurepip" ||
      name === "venv" ||
      name === "pip" ||
      name.startsWith("pip-") ||
      name === "setuptools" ||
      name.startsWith("setuptools-") ||
      name === "wheel" ||
      name.startsWith("wheel-")
    ) {
      continue;
    }

    const srcPath = path.join(src, name);
    const destPath = path.join(dest, name);

    if (entry.isDirectory()) {
      copyDirFiltered(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function main() {
  console.log("Preparing self-contained Python Print Agent runtime for Smart Xerox installer...");
  if (fs.existsSync(runtimeDestDir)) {
    fs.rmSync(runtimeDestDir, { recursive: true, force: true });
  }
  fs.mkdirSync(runtimeDestDir, { recursive: true });

  // 1. Copy agent.py and requirements.txt (never copy .env or completed_jobs.json)
  fs.copyFileSync(
    path.join(printAgentDir, "agent.py"),
    path.join(runtimeDestDir, "agent.py")
  );
  if (fs.existsSync(path.join(printAgentDir, "requirements.txt"))) {
    fs.copyFileSync(
      path.join(printAgentDir, "requirements.txt"),
      path.join(runtimeDestDir, "requirements.txt")
    );
  }

  // 2. Build relocatable Python runtime from base CPython + .venv/Lib/site-packages
  const venvDir = path.join(printAgentDir, ".venv");
  const basePythonHome = parsePyVenvCfg(venvDir);

  if (!basePythonHome || !fs.existsSync(basePythonHome)) {
    throw new Error(`Could not locate base Python home from ${venvDir}/pyvenv.cfg`);
  }

  console.log(`  Base Python Home : ${basePythonHome}`);
  console.log(`  Target Runtime   : ${runtimePythonDest}`);

  fs.mkdirSync(runtimePythonDest, { recursive: true });

  const rootFiles = [
    "python.exe",
    "pythonw.exe",
    "python3.dll",
    "python313.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "LICENSE.txt"
  ];

  for (const fileName of rootFiles) {
    const srcFile = path.join(basePythonHome, fileName);
    if (fs.existsSync(srcFile)) {
      fs.copyFileSync(srcFile, path.join(runtimePythonDest, fileName));
    }
  }

  copyDirFiltered(
    path.join(basePythonHome, "DLLs"),
    path.join(runtimePythonDest, "DLLs")
  );
  copyDirFiltered(
    path.join(basePythonHome, "Lib"),
    path.join(runtimePythonDest, "Lib")
  );

  // Copy pywin32, PyMuPDF, Pillow, requests, dotenv from .venv/Lib/site-packages into runtime Lib/site-packages
  const venvSitePackages = path.join(venvDir, "Lib", "site-packages");
  const destSitePackages = path.join(runtimePythonDest, "Lib", "site-packages");
  copyDirFiltered(venvSitePackages, destSitePackages);

  // Also copy pywin32 system DLLs (pywintypes313.dll, pythoncom313.dll) next to python.exe so Windows loader always finds them
  const pywin32Sys32 = path.join(venvSitePackages, "pywin32_system32");
  if (fs.existsSync(pywin32Sys32)) {
    for (const dll of fs.readdirSync(pywin32Sys32)) {
      if (dll.toLowerCase().endsWith(".dll")) {
        fs.copyFileSync(
          path.join(pywin32Sys32, dll),
          path.join(runtimePythonDest, dll)
        );
      }
    }
  }

  console.log("Portable Python Print Agent runtime prepared successfully.");
}

main();
