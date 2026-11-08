# Ethere

> 不只回应此刻，也记得一路走来的你。

Ethere 是一个 local-first 的个人 AI 助手原型：它把持续对话、长期记忆、任务提醒、语音通话和设备触达放在同一套协作体验里。项目包含 Web UI、Android 客户端、Node.js 服务、独立记忆服务、语音服务和 MCP 工具层。

## 在线体验

**[打开交互演示 →](https://miravalelab.github.io/Ethere-public/)**

演示使用虚构数据，完整呈现聊天、空间、时间线、记忆架构、学习计划、提醒、语音来电和监督弹窗等交互路径。

- [交互演示源码](docs/)
- [本地安装与运行](INSTALL.md)

## 它能做什么

### 延续而非重置的对话

- 基于可编辑的人设、相处规则与当前上下文进行流式对话。
- 用时间线沉淀经历与事件；在空间保存文字、图片和日常片段。
- 支持图片/文件附件、引用回复、Markdown、有序列表等聊天能力。

### 可追溯的长期记忆

- 核心记忆由模型提出、用户审批后生效；新线程也会优先加载。
- 普通经历由后台整理为 **Watch（继续观察）** 与 **Remember（稳定经历）**，并可带多条原始来源。
- 当前话题会经本地语义检索和主题锚点排序，按需找回相关线索；模型也能主动打开节点与来源，回顾当时的细节。
- 节点支持修订、追加来源、关联、替代、归档与遗忘，避免旧理解反复覆盖新状态。

### 把关心落实为行动

- 连接滴答清单：创建、修改、延期、重复任务和提醒；计划变化时同步更新后续触达。
- Check-in 可在适当时机读取近期状态、维护按需记忆或安排提醒；不需要联系时保持安静。
- 通过聊天消息、全屏监督弹窗和电话式提醒触达；完成、延期或取消后停止旧催促。
- 提供学习计划与进度卡片，让课程可以跨对话继续，而不是每次从头讲。

### 面向 Android 的陪伴体验

- 支持应用内连续语音通话：本地语音识别、可打断回复、流式文本转语音，以及可选 Fish Audio 音色。
- 支持主动来电、铃声/震动、扬声器或蓝牙设备切换，以及通话记录回写到聊天。
- 通过悬浮窗权限展示可关闭、可回传选择结果的监督弹窗。

### 受边界约束的工具协作

- MCP 将记忆、任务、提醒、时间线、空间、设备动作、文档与只读求职检索等能力暴露给模型。
- 核心记忆、人设和重要任务保留审批边界；读取型维护与设备动作会以可见卡片或事件回传。
- 开发代理桥将工程任务放到独立 Codex thread 执行，保存状态、结果摘要和测试信息，避免挤占日常对话上下文。

## Project layout

| Directory | Purpose |
| --- | --- |
| `web/` | Chat and settings UI shared with the Android WebView |
| `android/` | Capacitor-based Android shell and native device features |
| `server/` | Chat, reminders, memory, MCP, and integration services |
| `memory-lab/` | Local SQLite memory engine and semantic retrieval |
| `voice-lab/` | Separate speech recognition and synthesis service |
| `test/` | Backend and Web regression tests |
| `examples/` | Fictional persona and anonymized operations examples |
| `docs/` | Interactive showcase using the application frontend |

## Architecture at a glance

```text
Android WebView / Web UI
          │ HTTP + streaming events
          ▼
Node.js application server ── Codex app-server (chat thread)
          │                         └─ MCP tools with explicit approval boundaries
          ├─ local data directory (chat, timeline, space, reminders, configuration)
          ├─ SQLite memory service ── optional local embedding endpoint
          └─ optional voice service ── local ASR + Fish Audio TTS
```

The application server and its MCP child use the same explicit `ETHERE_DATA_DIR`. Core memory is separately approved; ordinary memory is retrieved by topic and can retain evidence. Background check-ins and reminders can wake a model turn, while device-facing actions remain distinguishable from ordinary messages.

## Runtime dependencies

The application source is included, but private data, API keys, cookies, model weights, and runtime binaries are not. The original setup uses Codex for conversation, a local `bge-base-zh-v1.5 Q8_0` embedding model served through `llama.cpp`, local `sherpa-onnx` speech recognition, and Fish Audio speech synthesis. Users must provide their own credentials and obtain compatible model files and runtimes separately. These integrations require configuration before their respective features can work.

For Fish Audio, set `FISH_API_KEY` in the voice-service process environment. See `.env.example` for placeholders; never commit a populated `.env`. The previous machine-specific Windows DPAPI key reader is not part of this public candidate.

The actual persona and all core memory are intentionally excluded. The files in `examples/` are only starting points; they are not loaded automatically and should be customized locally.

## Release notes

The public source tree has an independent Git history and excludes private runtime data, core memories, credentials, browser sessions, model files, logs, screenshots, APKs, and local configuration. See `SNAPSHOT_MANIFEST.md` for the audited scope and validation record.

## License

Ethere is released under **GNU AGPL-3.0-only**; see [LICENSE](LICENSE). `THIRD_PARTY_NOTICES.md` retains required third-party attribution and does not change the project license.
