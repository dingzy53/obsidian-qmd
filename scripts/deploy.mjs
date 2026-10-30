// Copy the built plugin into the vault. Set the target with QMD_PLUGIN_DIR.
import { copyFileSync, mkdirSync } from "fs";
import { join } from "path";

const target = process.env.QMD_PLUGIN_DIR;
if (!target) {
	process.stderr.write("Set QMD_PLUGIN_DIR to the plugin folder: <vault>/<config folder>/plugins/qmd-vault-search\n");
	process.exit(1);
}

mkdirSync(target, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
	copyFileSync(file, join(target, file));
}
process.stdout.write(`Deployed to ${target}\n`);
