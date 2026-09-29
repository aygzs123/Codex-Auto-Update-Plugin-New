import { useEffect, useRef } from "react";

/**
 * 命令结果用模态对话框呈现，不用右下角的 toast。
 *
 * toast 贴在右下角、还要用户自己注意到才会去点，而他点完「检查更新」之后眼睛还在
 * 主区按钮附近 —— 恰好是视线的另一头，很容易整个错过。可这里弹的都是*命令的唯一
 * 反馈*：「已经是最新版本，无需安装」「Codex 已启动」「资源副本已重建」。
 * 漏掉一条，用户就不知道刚才那一下到底做了什么，只能再点一遍。
 *
 * 所以改成模态：浮在正中、盖住底色，必须点「知道了」（或 Esc）才消失。
 * 这里承载的都是信息性结论，没有需要用户抉择的分支，所以只有一个确认按钮。
 */
export function NoticeDialog({ message, onClose }: { message: string; onClose: () => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // 打开就把焦点放到确认按钮：键盘用户回车即可关掉，也免得焦点还留在背后的页面上。
    confirmRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      // 点遮罩关掉，点对话框内部不关 —— 否则在卡片里选中那句提示的文字都会把它关掉。
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="notice-dialog-title">
        <h3 id="notice-dialog-title">提示</h3>
        <p>{message}</p>
        <div className="modal-actions">
          <button ref={confirmRef} type="button" className="button primary" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
