# Third-Party Notices

FeiGe is licensed under Apache-2.0. Components listed below retain their own
licenses; the FeiGe license does not replace those terms.

## FFmpeg

The Windows green package includes FFmpeg as separate executable and shared
library files under `vendor/`. The included build is:

- FFmpeg `n7.1.5-2-g998de74adf-20260713`
- Windows x64 LGPL shared variant from
  [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)
- FFmpeg source revision
  [`998de74adf`](https://github.com/FFmpeg/FFmpeg/commit/998de74adf)

The complete license text is included as `vendor/FFMPEG-LGPL-3.0.txt`. Build
and source information is included as `vendor/README.txt`. This build does not
enable FFmpeg's GPL or nonfree configuration options.

## JavaScript dependencies

FeiGe uses Electron, electron-builder, archiver, docx, exceljs, undici, and
their transitive dependencies. Their license notices are retained in the
installed dependency packages and in the packaged application as applicable.
