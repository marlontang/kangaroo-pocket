# kangaroo-pocket

<img src="build/logo.png" alt="kangaroo-pocket 袋鼠 Logo" width="160">

kangaroo-pocket 是一款本地优先的桌面信息收纳工具。把文字或图片发给「袋鼠」，应用会先在本地保存内容，再调用兼容 OpenAI 协议的大模型自动分类到「生活」「工作」「项目」等会话中。

应用支持 macOS 和 Windows，基于 Electron、React、TypeScript 与本地 SQLite 构建。消息数据保存在本机；AI 只负责判断分类，不会改写原始内容。

<p align="center">
  <img src="assets/kangaroo-pocket-overview.png" alt="kangaroo-pocket 三栏主界面" width="1100">
</p>

## 下载

前往 [GitHub Releases](https://github.com/marlontang/kangaroo-pocket/releases/latest) 下载最新版：

- macOS Apple Silicon（arm64）DMG
- macOS Intel（x64）DMG
- Windows（x64）安装程序

当前安装包尚未进行代码签名。macOS 首次启动时需右键应用并选择「打开」；Windows 可能显示 SmartScreen 提示。

## 功能特性

- 消息先落库、后分类，断网或模型不可用时内容仍然安全保存
- 自定义分类及分类说明，支持 AI 识别分类方案
- 手动移动、重新分类、批量重跑分类
- 图片粘贴、拖入、预览与独立归类
- 全局搜索、软删除、撤销、垃圾箱还原
- API Key 使用系统安全存储，开发环境可通过 `.env` 注入

## 技术栈

- Electron + electron-vite
- React + TypeScript
- Zustand
- SQLite
- Vitest

## 环境要求

- Node.js 20 或更高版本
- npm 10 或更高版本
- macOS 或 Windows
- 一个兼容 OpenAI Chat Completions 接口的模型服务

## 快速开始

```bash
git clone https://github.com/marlontang/kangaroo-pocket.git
cd kangaroo-pocket
npm install
npm run dev
```

也可以使用项目脚本启动：

```bash
./server.sh start
```

首次运行后，在「小袋鼠」中填写模型服务信息。默认配置适用于阿里云百炼：

| 配置项 | 默认值 |
| --- | --- |
| Base URL | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 模型 | `qwen3.6-flash` |
| API Key | 在[阿里云百炼](https://bailian.console.aliyun.com/)申请 |

开发时可以在项目根目录创建 `.env`。该文件已被 Git 忽略，不要提交真实密钥：

```dotenv
QWEN_API_KEY=your_api_key
QWEN_MODEL=qwen3.6-flash
QWEN_API_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

## 使用方式

1. 在「袋鼠」会话中发送文字或图片，内容会立即保存在本地。
2. AI 完成判断后，消息会显示分类标签，并出现在对应分类会话中。
3. 分类错误时，右键消息选择「移动到」或「重新分类」。
4. 使用「小袋鼠」中的「识别分类」生成分类方案，或用「开始分类」重跑历史消息。
5. 使用 `Command/Ctrl + F` 搜索全部历史消息。
6. 点击侧栏底部的菜单按钮，可以导入或导出完整数据备份。

「袋鼠」会话是完整时间线；在分类会话中直接发送的消息会手动归入当前分类。手动指定的分类不会被后续自动分类覆盖。

## 数据备份

导出文件采用版本化 JSON 格式，包含分类、消息、垃圾箱状态和图片原文件，不包含 API Key。导入采用合并模式：同名分类复用，新分类和消息追加，不会清空或覆盖当前数据。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动开发模式和热更新 |
| `npm run build` | 构建应用 |
| `npm run typecheck` | 运行 TypeScript 类型检查 |
| `npm test` | 运行单元测试 |
| `npm run test:e2e` | 构建并运行端到端测试 |
| `npm run test:ui` | 构建并运行界面测试 |
| `npm run dist` | 构建 macOS Apple Silicon 安装包 |
| `./server.sh help` | 查看完整管理命令 |

## 打包

```bash
./server.sh package mac    # macOS
./server.sh package win    # Windows
./server.sh package all    # macOS arm64/x64 + Windows x64
```

安装包输出到 `release/`，该目录不会提交到 Git。默认产物未进行代码签名，正式分发前应配置对应平台的开发者证书。

## 项目结构

```text
src/main/       Electron 主进程、数据库与分类服务
src/preload/    安全的渲染进程桥接层
src/renderer/   React 用户界面
src/shared/     主进程与渲染进程共享类型
test/           单元、集成和端到端测试
build/          图标生成脚本及打包资源
```

## 数据与隐私

- 消息及分类数据保存在本机 SQLite 数据库中。
- API Key 通过系统安全存储保存，不写入项目文件。
- 文字在分类时会发送给用户配置的模型服务；图片不会发送给模型。
- `.env`、运行日志、构建产物和本地缓存均已加入 `.gitignore`。

## License

本项目基于 [MIT License](LICENSE) 开源。
