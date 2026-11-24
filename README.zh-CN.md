# 小说配音（LaiVox）

[English](README.md) · **简体中文**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的有声书插件：把 TXT / EPUB / 文字型 PDF 小说做成单人朗读或多角色配音的音频，也能把 AI 的回答直接读给你听。默认使用微软 Edge 在线语音，不用注册账号。

![LaiVox 工作台：书架、正文与播放器](assets/screenshots/listen.png)

## 能做什么

- **听手里的小说**：导入 TXT、EPUB 或文字型 PDF，自动分章，入库前先看预览。选一章点「开始制作」，前两段合成好就能播放，不用等整章。
- **给角色配不同的声音**：选「多角色演绎」，由你在 DSH 里配置的模型标注谁在说话、什么语气，再按角色配音。开始前会列出预计请求数，你确认后才调用模型。
- **使用 LaiVox 音色（可选）**：LaiVox 付费会员可在「设置 → 制作」把引擎换成 LaiVox，使用 LaiVox 的角色音色和逐句语气，也能用自己在 LaiVox 浏览器扩展里上传的音色。默认仍是 Edge。
- **让 AI 帮你准备**：在对话里说"把工作目录里的 book.txt 做成有声书"，AI 会在回答下方给出导入预览和制作单。你点确认才会导入、制作；AI 发起的任务排在你已有的任务后面，不打断你。
- **把回答读给你听**：点回答下方的喇叭「用 Edge 朗读」，或者直接说"读给我听"。已闭合的代码块和链接地址会跳过，表格会读出单元格里的文字。
- **随手听一段**：在输入框输入 `/laivox 一段文字`，就能把它做成音频，结果收在「书架 → 对话音频」。
- **带走**：单章下载 MP3 / WAV，整本导出为按章命名的 ZIP。

每个场景的详细步骤见 [使用指南](docs/GUIDE.md)。

| 角色与音色 | 导入预览 | 对话音频 | 深色主题 |
|---|---|---|---|
| ![角色](assets/screenshots/roles.png) | ![导入](assets/screenshots/import.png) | ![对话音频](assets/screenshots/snippets.png) | ![深色主题](assets/screenshots/listen-dark.png) |

## 安装

先准备好 `dsh` 命令：

- **DSH 桌面版**：在「应用程序」菜单里选「管理 dsh 命令…」→「安装」（在「检查更新」下方）。打开一个新终端，运行 `dsh --version` 确认可用。桌面版的 Profile 名是 `desktop`。安装插件前先打开一次桌面版，再**完全退出**（包括系统托盘），然后运行下面的命令。参见 [官方桌面版文档](https://github.com/deepseek-ai/deepseek-harness/blob/38a6a5c/apps/desktop/README.zh.md#终端命令)。
- **DSH Web / 命令行版**：需要 Node.js 24.9 或更新版本。下面的示例 Profile 名是 `web`。

命令里的 `desktop` 换成你自己的 Profile 名即可。

### 远程安装：从最新发布版安装（推荐）

```sh
dsh plugin --profile desktop add "https://github.com/xiaolai181/dsh_laivox_tts/releases/latest/download/dsh-laivox-tts.tgz"
```

这是预构建的插件包，不在你的电脑上编译，也不需要授权构建。想固定版本时，把 `latest/download` 换成 `download/v0.7.6`。所有版本见 [Releases](https://github.com/xiaolai181/dsh_laivox_tts/releases) 页面。

### 本地安装：用下载好的插件包

从 [Releases](https://github.com/xiaolai181/dsh_laivox_tts/releases) 下载 `dsh-laivox-tts.tgz`，在文件所在目录运行：

```sh
dsh plugin --profile desktop add ./dsh-laivox-tts.tgz
```

这种方式不需要联网，适合访问不了 GitHub 的电脑。

### 本地安装：从源码目录安装（开发者）

```sh
git clone https://github.com/xiaolai181/dsh_laivox_tts.git laivox-tts
cd laivox-tts
npx pnpm install          # 必须用 pnpm，安装时会自动构建 lib/
dsh plugin --profile desktop add .
```

Profile 链接的是这个目录本身，安装后不要移动或删除它。`git pull` 之后要再运行一次 `npx pnpm install` 重新构建。

> **从源码目录安装换成插件包安装时**：`dsh plugin remove` 之后，Profile 的 `node_modules` 里还会留一个名为 `dsh-laivox-tts` 的链接。先删掉这个链接，并且只删链接本身（Windows 上用不带 `/s` 的 `rmdir`），否则下一次安装可能会删掉源码目录里的文件。

### 安装之后

- **桌面版**：重新打开 DeepSeek Harness。**Web 版**：重启 `dsh web`。
- 侧栏里会出现「小说配音（LaiVox）」。
- 查看已安装的插件：`dsh plugin --profile desktop list`

### 更新与卸载

- **更新**：再运行一次安装命令。用 `latest/download` 链接安装的，会取到最新发布版。
- **卸载**：`dsh plugin --profile desktop remove dsh-laivox-tts`。书架和音频仍保留在本机（见 [数据保存在哪](#数据保存在哪)）。

## 上手五分钟

在 **DSH 设置 → 通用设置 → 语言** 选择简体中文、繁体中文或英文，插件界面会跟随切换。

1. 从侧栏打开「小说配音（LaiVox）」。工作台顶部有三个页签：**收听**、**制作**、**书架**；右上角是任务和设置。
2. 进入 **书架 →「导入 TXT / EPUB / PDF」**，选择文件。分章不对时，点章节标题调整，然后确认导入。
3. 打开一章，选「单人朗读」，点「开始制作」。这一步不用 AI。
4. 前几段就绪后点播放。播放器里有倍速、定时关闭、书签和随读高亮；一章播完会自动续播下一章，可在设置里关闭。

不想导入文件、只想粘贴正文时，用 **书架 →「新建书籍」**。

全新空白 Profile 首次打开插件时，书架会预置两本试听示例：《社戏 · 月夜行船 · Edge》（由微软 Edge 在线语音单人朗读生成）与《绿野仙踪 · 营救铁皮人 · LaiVox》（由 LaiVox 预置音色多角色演绎生成）。无需配置 API Key，可直接点「试听示例」或在书架打开收听。

## 隐私与费用

- **Edge 语音**免费，不需要账号。要合成的文字会通过非官方在线朗读协议发送到微软 Edge 在线语音服务，可用性与服务条款受微软方约束，本项目不作稳定性保证。
- **AI 功能**（清洗正文、多角色编剧、AI 辅助分章）使用你在 DSH 里配置的模型，计入该模型的额度。每一步都会先显示预计请求数，等你确认。单人朗读从不调用模型。
- **LaiVox 引擎**是可选的，需要 LaiVox 付费会员或朗读时长包：在「设置 → 制作」选 LaiVox，并保存 LaiVox 账号的 API Key。要合成的正文会发送到 LaiVox 服务并按其服务与保留策略处理。合成使用该账号的语音额度，与 LaiVox 浏览器扩展共用。当天额度用完时，可以确认后开启下一个使用日，或者用 Edge 音色补完这一章。在 LaiVox 浏览器扩展里上传的音色可以分配给角色，上传和修改仍在扩展里进行。Key 保存在 DSH 的凭据服务里，只有在你使用 LaiVox 时插件才会连接它。
- **版权与合规**：请仅导入和合成你拥有合法权利的文本内容；生成的音频仅供个人合规使用。
- AI 只能读取当前对话工作目录里的文件，也不能删除你的书。

## 数据保存在哪

所有数据都在本机的 Profile 目录里：`<DSH 主目录>/profiles/<Profile 名>/dsh-laivox-tts/`，DSH 主目录默认是 `~/.dsh`。书架、台词脚本、任务、音频和播放进度都存在其中的 `library.sqlite`。

- **升级前请备份**：完全退出 DSH，复制整个 `dsh-laivox-tts` 目录。新版本可能会升级数据库（当前为 v12），升级后旧版本打不开。
- **音频空间**：默认上限 2 GiB，可在「设置 → 存储」调整为 512 MiB～20 GiB。空间不够时新的制作会暂停；可以按书或按章清理音频，正文和台词会保留。
- **对话音频**超过 7 天没听会自动删除，可改为 1 天、30 天或永不。保存到书架后就不会再自动删除。
- **内置试听示例**仅在全新空白 Profile 首次启动时写入一次（已有书籍的老 Profile 升级不会写入），可在书架随时删除，删除后重启或升级不会重新出现。
- 想彻底清除：卸载插件后删除 `dsh-laivox-tts` 目录。

## 已知限制

- 确认按钮、导入预览和结果只出现在最后一轮回答下方，更早的回合里不会出现。
- 朗读的第一句约 2 秒才开始，之后每句约 0.5～1 秒。
- 同一个对话在两个窗口同时打开时，AI 发起的朗读两个窗口都会播放。
- 单个导入文件最大 50 MiB，每本书最多 5,000 章。

## 许可

LaiVox 自有的插件代码采用 [MIT 许可证](LICENSE)，LaiVox TTS 服务端和服务访问权限不在此范围内。LaiVox 品牌、图标和预置试听音频按各自的授权使用，详见 [许可与第三方声明](THIRD_PARTY_NOTICES.md)。
