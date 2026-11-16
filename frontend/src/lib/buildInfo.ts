declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;

/** The version of this code, from package.json. */
export const APP_VERSION: string = __APP_VERSION__;

/** The commit this build was made from (`a1b2c3d`, or `a1b2c3d modified` with uncommitted changes); empty when
 *  unknown. Shown under about only. */
export const APP_COMMIT: string = typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : '';

export const REPOSITORY_URL = 'https://github.com/j-nivekk/Stepthrough';
/** The DOI of Stepthrough on Zenodo, for citing it: all versions, so it always leads to the newest. */
export const DOI = '10.5281/zenodo.24159849';

// The Docker build passes the image's tag in: a release carries its version number (`1.0.0`, `1.0.0-ocr`), a
// build of the main branch carries `edge`. Builds from source carry nothing.
const build = String(import.meta.env.VITE_BUILD_VERSION ?? '').trim();

/** Which build this is when it is not a release, such as `edge`; empty for releases and local builds. */
export const BUILD_LABEL = !build || build === 'dev' || /^\d/.test(build) ? '' : build;

/** As shown at the bottom right: `v 1.0.0`, or `v 1.0.0 · edge`. The commit is under about. */
export const VERSION_LABEL = `v ${APP_VERSION}${BUILD_LABEL ? ` · ${BUILD_LABEL}` : ''}`;
