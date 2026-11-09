import type { ExamplePrompt, ChatMessage, PublicSettings } from '../lib/api';
import { Composer } from './Composer';
import { ErrorNotice, MessageList, XmlPreview } from './MessageList';
import { IconBolt, IconChat, IconKey, IconSparkles } from './Icons';

interface AgentPanelProps {
  messages: ChatMessage[];
  thinking: boolean;
  busy: boolean;
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onSuggestion: (text: string) => void;
  onRegenerate: () => void;
  settings: PublicSettings | null;
  examples: ExamplePrompt[];
  onPickExample: (prompt: string) => void;
  xml: string;
  error: string | null;
  onDismissError: () => void;
  hasDiagram: boolean;
}

/** One-click edits that always work, even in offline mode. */
const QUICK_ACTIONS: Array<{ label: string; prompt: string }> = [
  { label: '改为横向布局', prompt: '把布局改成从左到右（横向）' },
  { label: '切换浅色主题', prompt: '改成浅色主题，适合打印' },
  { label: '加一个失败分支', prompt: '为关键判断节点补充一条失败分支，并标注失败原因' },
  { label: '补充缓存层', prompt: '在数据访问层前补充一个缓存层（Redis），并标注读写路径' },
];

export function AgentPanel({
  messages,
  thinking,
  busy,
  input,
  onInputChange,
  onSend,
  onSuggestion,
  onRegenerate,
  settings,
  examples,
  onPickExample,
  xml,
  error,
  onDismissError,
  hasDiagram,
}: AgentPanelProps) {
  const online = settings?.provider === 'deepseek';
  const providerLabel = online ? `DeepSeek · ${settings?.model ?? ''}` : '内置规则引擎（未配置 API Key）';

  return (
    <aside className="panel" aria-label="AI 对话面板">
      <div className="panel__header">
        <div className="panel__header-icon">
          <IconChat />
        </div>
        <div className="panel__header-text">
          <span className="panel__title">AI 绘图助手</span>
          <span className="panel__subtitle" title={providerLabel}>
            {providerLabel}
          </span>
        </div>
        {hasDiagram && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={onRegenerate}
            disabled={busy}
            title="按第一条描述重新生成整张图"
          >
            <IconBolt style={{ width: 13, height: 13 }} />
            重生成
          </button>
        )}
      </div>

      <div className="panel__body">
        {!online && (
          <div className="alert alert--warning">
            <span className="alert__icon">
              <IconKey />
            </span>
            <div className="alert__body">
              <strong>当前为离线模式</strong>
              <div style={{ marginTop: 2 }}>
                未检测到 DeepSeek API Key，图表由内置规则引擎生成，界面与画布完全可用。
                配置 Key 后将启用 DeepSeek V4.1 Flash 的完整理解与连续修改能力。
              </div>
            </div>
          </div>
        )}

        {error && <ErrorNotice message={error} onRetry={onDismissError} />}

        {messages.length === 0 && !thinking ? (
          <div className="panel__empty">
            <div className="panel__empty-icon">
              <IconSparkles />
            </div>
            <div className="panel__empty-title">描述你想画的图</div>
            <p className="panel__empty-text">
              例如「画一个订单支付的流程图」「梳理微服务架构」「用思维导图规划产品」。
              生成后可以继续用自然语言修改，画布会实时更新。
            </p>
          </div>
        ) : (
          <MessageList
            messages={messages}
            thinking={thinking}
            thinkingLabel={online ? '正在调用 DeepSeek 生成图表…' : '正在生成图表…'}
            onSuggestion={onSuggestion}
            busy={busy}
          />
        )}

        {hasDiagram && (
          <div>
            <div className="panel__section-label">快速调整</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {QUICK_ACTIONS.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  className="chip"
                  disabled={busy}
                  onClick={() => onSuggestion(action.prompt)}
                  title={action.prompt}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.length === 0 && !thinking && examples.length > 0 && (
          <div>
            <div className="panel__section-label">示例</div>
            <div className="panel__examples">
              {examples.map((example) => (
                <button
                  key={example.title}
                  type="button"
                  className="chip"
                  disabled={busy}
                  onClick={() => onPickExample(example.prompt)}
                  title={example.prompt}
                >
                  <span className="chip__icon">{example.icon}</span>
                  <span className="truncate">{example.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {hasDiagram && (
          <div>
            <div className="panel__section-label">draw.io 源文件</div>
            <XmlPreview xml={xml} />
          </div>
        )}
      </div>

      <div className="panel__footer">
        <Composer
          value={input}
          onChange={onInputChange}
          onSubmit={onSend}
          disabled={false}
          busy={busy}
          placeholder={hasDiagram ? '继续描述修改，例如：加一个风控校验步骤' : '描述你想要的图表…'}
          hintLeft={hasDiagram ? '追问可连续修改当前图表' : '支持流程图 / 架构图 / 思维导图 / ER 图等'}
        />
      </div>
    </aside>
  );
}
