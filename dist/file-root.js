import { isAbsolute, relative, resolve, sep } from 'node:path';
/** Directory upload tools confine local paths to this variable; unset means no restriction. */
export const FILE_ROOT_ENV = 'UPTODOWN_FILE_ROOT';
/** Root that local file paths must stay inside, or `null` when unrestricted. */
export function resolveFileRoot(env = process.env) {
    const configured = (env[FILE_ROOT_ENV] ?? '').trim();
    return configured === '' ? null : resolve(configured);
}
/**
 * Rejects a path that resolves outside the root.
 *
 * Containment is decided with `path.relative`, not `startsWith`, which would accept
 * `C:\ab\file` for a root of `C:\a`. Runs before hashing or opening, so a rejected path
 * never touches disk.
 */
export function assertUploadPathAllowed(filePath, root = resolveFileRoot()) {
    if (root === null)
        return;
    const target = resolve(filePath);
    const relativePath = relative(root, target);
    const escapesRoot = relativePath === '..' || relativePath.startsWith(`..${sep}`);
    if (!escapesRoot && !isAbsolute(relativePath))
        return;
    throw new Error(`${FILE_ROOT_ENV} is set to "${root}": "${filePath}" is outside that directory, so the upload was blocked. ` +
        `Move the file under the root, or unset ${FILE_ROOT_ENV} to allow any local path.`);
}
