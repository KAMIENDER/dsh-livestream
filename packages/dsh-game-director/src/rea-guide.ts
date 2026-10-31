/** CLI workflow handed to the development preset's existing DSH shell tool; no new shell backend. */
export function reaGuide(command: string): string {
  return [
    '缺少公开源码时的 REA 静态调查流程：',
    `REA 程序配置（单个可执行文件，按 argv 程序名处理，不当成 shell 片段）：${JSON.stringify(command)}`,
    '通过当前预设已有的 Bash/PowerShell 工具调用已安装的 REA；正确引用每个路径。先读取 --version --json 和 --help，确认版本、Node 要求和可用子命令。未安装或运行时不匹配时记录阻碍，不通过 npx 自动下载、不运行 setup 或升级系统。',
    '调查 artifactPath 指向的真实本机文件。未提供时，从用户给出的游戏目录、当前工作区或该游戏的标准安装位置定位，并记录实际命中的路径；不要把目录不存在当成文件已分析。',
    '先识别程序格式。可对已定位的游戏安装目录用 inspect-desktop-application（先读该命令 --help）检查组件，再选具体程序集、脚本或原生二进制。只做静态分析，不调用运行时捕获、启动游戏或改写目标的命令。',
    '.NET PE/CLI：先 inspect-managed-artifact <实际程序集路径> --format json 取身份与覆盖情况，再 inspect-managed-members；--type 只能使用查询返回的准确类型名。这些结果是元数据和 CIL，不是原始 C# 源码，也不能证明函数可以安全调用。',
    '成员结果可能很大。当前 REA 支持时使用 --detail summary --evidence-bundle <本次目录内的全新文件> --format json；父目录先创建，之后通过 inspect-analysis-view 分页读取 Evidence。若达到资源上限，按1–3个相关类型分组重读并核对 coverage；不能把空成员集合或截断当作不存在或全量。先用实际版本 --help 确认选项。',
    'JavaScript/Electron：用 analyze-javascript-application 检查实际脚本、模块与导入关系。原生游戏需要已配置的 Ghidra/Hopper/IDA/Kuna 等分析引擎；按本机 REA 的帮助和官方指南选提供方，不把引擎缺失伪装成分析成功。',
    '原生反编译代码和托管 IL 都是调查证据。保留文件摘要、版本、证据 ID、方法签名或地址，再分析状态读取、输入分发、更新循环与线程要求，设计最小 Mod/桥接层。不要直接猜地址或据此修改正在运行的进程。',
    '在本次目录写 investigation.md，列出已读源码或 REA 证据的位置、真实接入点、尚未确认的结论和依赖。只能在找到实际控制路径后写接入；不要用恒定假状态或空操作冒充完成。',
    '官方依据：',
    'https://github.com/morluto/rea/blob/main/docs/managed-code-analysis.md',
    'https://github.com/morluto/rea/blob/main/docs/cli.md',
    'https://github.com/morluto/rea/blob/main/docs/client-configuration.md#deepseek-harness',
  ].join('\n');
}
