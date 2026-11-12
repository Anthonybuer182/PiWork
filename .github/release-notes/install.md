## 安装提示

本版本没有 Apple Developer ID 签名和公证，下载后首次启动会被系统拦截一次。

**macOS**

1. 把 `PiWork.app` 拖进「应用程序」。
2. 提示「无法验证开发者」时：打开「系统设置 → 隐私与安全性」，在底部点「仍要打开」。
3. 如果双击后完全没有反应（macOS 26 会静默拦截，不弹窗），在「终端」执行一次：

   ```bash
   xattr -dr com.apple.quarantine "/Applications/PiWork.app"
   ```

   然后再打开即可。

**Windows**

SmartScreen 提示时点「更多信息 → 仍要运行」。
