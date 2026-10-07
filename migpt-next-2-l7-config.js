function isXiaoAIAnswerFailure(text) {
  return /(?:我(?:还|暂时|暂不|也)?(?:不知道|不知道咋说|不太清楚|不支持|不会|回答不上)|不太清楚|无法(?:回答|理解|获取|处理)|没法回答|回答不了|没听懂|不明白.{0,8}(?:说|意思)|换个问题|我还在学习|(?:你|我).{0,4}(?:问住|难住)了|被难住了(?:诶|呢|呀|哦)?|暂不支持(?:该|此)?功能|不知道咋说|还.{0,4}(?:支持.{0,6}功能|学习)|不如换.{0,6}(?:方式|问题|说)|超出.{0,6}(?:能力|范围)|(?:没有|无法)找到.{0,8}(?:答案|结果|内容)|(?:暂时|还)回答不)/i.test(
    text,
  );
}

/**
 * 切换到外接 LLM 时先播报的占位提示，用来填补"小爱答不上来 → LLM 返回结果"之间的静默空档。
 *
 * - 设为 ''（空字符串）即可关闭。
 * - 文本越短，占用的时间越少；建议 8~12 字。
 */
const LLM_THINKING_NOTICE = '切换外接大模型，请稍等';

/**
 * L07A（Redmi 小爱音箱 Play）专用 TTS 配置。
 *
 * L07A 不支持 MiNA 通道的 ubus mibrain/text_to_speech，所以 engine.speaker.play() 返回成功
 * 但音箱不出声。必须改用 MIoT 的 play-text 动作。
 *
 * 其他型号参考表（按 home.miot-spec.com 的智能音箱服务 play-text 动作编号）：
 *   - LX06 / S12 / LX01 / LX04 / L06A / LX5A / LX05 / M01：[5, 1]
 *   - L05B / L05C / OH2 / ASX4B / X4B：[5, 3]
 *   - L15A / X10A / L17A / X6A / OH2P：[7, 3]
 *   - L09A：[3, 1]
 *   - L07A：[5, 1]  ← 你这台
 */
const TTS_COMMAND = [5, 1];

/**
 * 自定义播放：绕过 engine.speaker.play()（MiNA 通道），改走 MIoT play-text。
 * 适用于 L07A 等 MiNA 通道无响应但 MIoT 通道正常的型号。
 *
 * ⚠️ 关键:不要切片！
 * MIoT play-text 是无状态命令，每次调用都是一条独立的 TTS 请求，云端只发命令
 * 不等待播放完成。如果串行发多段，后一段会把前一段正在播放的内容顶掉，
 * 导致只听到开头一截、日志却全打出来了。
 *
 * L07A 的 text-content 实测单次能吃 ~300 中文字符，配合 stream.maxReplyLength=100
 * 的限制，整段一次发即可。
 */
async function playOnDevice(engine, text) {
  if (!text) return;

  // 清理 Markdown / 链接标记，避免音箱念出 "星号星号"
  const cleaned = String(text)
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/_/g, '')
    .replace(/`/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .trim();

  if (!cleaned) return;

  await engine.MiOT.doAction(...TTS_COMMAND, cleaned);
}

/**
 * @type {import('@mi-gpt/next').MiGPTConfig}
 */
export default {
  debug: false, // 是否开启调试模式
  speaker: {
    /**
     * 小爱音箱在米家中设置的名称
     *
     * 如果提示找不到设备，请打开调试模式获取设备真实的 name、miotDID 或 mac 地址填入
     */
    did: '小米AI音箱',
    /**
     * 小米 ID（一串数字）
     *
     * 注意：不是手机号或邮箱，请在小米账号「个人信息」-「小米 ID」查看
     */
    userId: '小米 ID（一串数字）',
    /**
     * 小米账号登录密码
     *
     * 如果提示登录失败，请使用 passToken 登录
     */
    password: '小米账号登录密码',
    /**
     * （可选）小米账号 passToken
     *
     * 获取教程：https://github.com/idootop/migpt-next/issues/4
     */
    passToken: 'V1:pwxxxxxxxxxxxxxxxxxxxxxxxxxxxQw==',
  },
  openai: {
    enableProxy: true,
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: 'ark-xxxx',
    model: 'ep-2026xxxx',
    webSearch: {
      enabled: true,
      strategy: 'hybrid',
      fallbackNotice: '联网搜索暂时不可用，以下内容可能不是最新。',
    },
    extra: {
      requestOptions: {
        timeout: 60000,
      },
    },
  },
  prompt: {
    system: '你是一个智能助手，请用简洁的语言回答用户的问题，每次回答控制在150字以内。',
  },
  context: {
    historyMaxLength: 10,
  },
  stream: {
    /**
     * L07A 不支持连续对话/流式轮询，保持较小分句即可。
     */
    maxReplyLength: 100,
  },
  callAIKeywords: [''],
  /**
   * 自定义消息回复
   *
   * 关键修改：原版用 engine.speaker.play({ text }) 走 MiNA 通道，
   * 在 L07A 上返回成功但不出声；这里改成 engine.MiOT.doAction(5, 1, text)
   * 走 MIoT 的 play-text 动作，L07A 才能真正发声。
   */
  async onMessage(engine, msg) {
    if (!engine.config.callAIKeywords?.some((keyword) => msg.text.startsWith(keyword))) {
      return;
    }

    const xiaoAIAnswer =
      typeof msg.metadata?.xiaoAIAnswer === 'string' ? msg.metadata.xiaoAIAnswer.trim() : '';
    if (xiaoAIAnswer && !isXiaoAIAnswerFailure(xiaoAIAnswer)) {
      console.log(`🔈 保留小爱原生回答：${xiaoAIAnswer}`);
      return { handled: true };
    }
    if (xiaoAIAnswer) {
      console.log(`🤖 小爱无法回答，切换外接 LLM：${xiaoAIAnswer}`);
    }

    const stopped = await engine.speaker.abortXiaoAI();
    if (!stopped) {
      console.warn('⚠️ 未能确认已停止小爱原生播报，继续切换外接 LLM');
    }

    const answerPromise = engine.askAI(msg, { stream: false });

    if (LLM_THINKING_NOTICE) {
      try {
        await playOnDevice(engine, LLM_THINKING_NOTICE);
      } catch (error) {
        console.warn('⚠️ 播放占位提示失败：', error);
      }
    }

    const { text } = await answerPromise;
    if (text) {
      console.log(`🔊 ${text}`);
      try {
        await playOnDevice(engine, text);
      } catch (error) {
        console.error('❌ MIoT TTS 调用失败：', error);
      }
    }

    return { handled: true };
  },
};