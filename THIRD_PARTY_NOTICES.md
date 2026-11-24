# 许可与第三方声明

[MIT 许可证](LICENSE)适用于 LaiVox 自有的 DSH 插件软件。第三方组件继续适用各自的许可证。

LaiVox 的品牌名称、商标、品牌图标（`icon.svg`、`assets/icon-180.png`）、`assets/voice-previews/` 中的预置试听音频以及 `assets/samples/` 中的示例音频不在此 MIT 许可范围内。

- `assets/voice-previews/` 中的 26 份预置音色试听音频，以及 `assets/samples/` 中基于公版英文原著《The Wonderful Wizard of Oz》（1900）第五章编写的中文节译文本与 LaiVox 多角色示例音频，版权归 LaiVox 所有，仅授权随本插件原样分发并用于插件内试听；未经书面许可，禁止单独提取、再分发、用于模型训练或商业复用。
- `assets/samples/` 中的鲁迅《社戏》（1922 年公版原文）月夜行船单人朗读示例音频由微软 Edge 在线语音服务生成，仅作为插件内置试听示例提供；使用 Edge 在线语音及随附音频仍受微软对应服务条款约束。

LaiVox 自有的 TTS 服务端软件不在此许可范围内。插件代码的许可不授予 LaiVox TTS 服务访问权限，也不授予任何账号、API Key 或调用额度的使用权。

## 第三方依赖

- [dsh-plugin-tts](https://github.com/1624318455/dsh-plugin-tts/tree/e8d1edd2ba5954a05258f7e4b6b753aab430b8eb) 作为 Edge 合成的实现参考，采用其独立 Node worker、分段和超时重试思路。
- [msedge-tts](https://github.com/Migushthe2nd/MsEdgeTTS)（MIT）负责 Edge Read Aloud 在线连接和协议处理（连接微软 Edge 非官方在线朗读接口，可用性与服务条款受微软方约束）。构建时它连同所依赖的 axios、ws 等包被打包进 `lib/vendor/msedge-tts.cjs`，不修改其源码；这些包的名称、版本和原始许可声明逐个收录在同目录的 `msedge-tts.licenses.txt`。
- [mpg123-decoder](https://github.com/eshaz/wasm-audio-decoders/tree/main/src/mpg123-decoder) 负责 MP3 解码，依赖及其许可证随安装包依赖分发。
- [@breezystack/lamejs](https://github.com/shijinyu/lamejs) 1.2.7（LGPL-3.0）负责把 PCM 编码为 MP3；只在宿主的 worker 线程中按需加载，不修改其源码，按依赖分发。
- [pdfjs-dist](https://github.com/mozilla/pdf.js) 6.5.438（Apache-2.0）负责在导入 worker 中离线提取文字型 PDF 的正文与目录大纲，不修改其源码，随安装包依赖分发。

`assets/voice-previews/` 内的 26 份中文 WAV 对应预设音色清单与参考音，仅用于插件内试听对应预设；清单记录了音色 ID、文件名和 SHA-256。

## lucide-react

版本 1.63.0，用于界面图标或浮层定位。

```text
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## @floating-ui/dom

版本 1.8.0，用于界面图标或浮层定位。

```text
MIT License

Copyright (c) 2021-present Floating UI contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
