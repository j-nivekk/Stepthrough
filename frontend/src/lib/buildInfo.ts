declare const __APP_VERSION__: string;

/** The version of this code, from package.json. */
export const APP_VERSION: string = __APP_VERSION__;

// The Docker build passes the image's tag and commit in: a release carries its version number (`1.0.0`,
// `1.0.0-ocr`), a build of the main branch carries `edge`. Builds from source carry nothing.
const build = String(import.meta.env.VITE_BUILD_VERSION ?? '').trim();
const revision = String(import.meta.env.VITE_BUILD_REVISION ?? '').trim().slice(0, 7);

/** Which build this is when it is not a release, such as `edge 80892ff`; empty for releases and local builds. */
export const BUILD_LABEL =
  !build || build === 'dev' || /^\d/.test(build)
    ? ''
    : [build, revision && revision !== 'unknown' ? revision : ''].filter(Boolean).join(' ');

/** As shown at the bottom right: `v 1.0.0`, or `v 1.0.0 · edge 80892ff`. */
export const VERSION_LABEL = `v ${APP_VERSION}${BUILD_LABEL ? ` · ${BUILD_LABEL}` : ''}`;
