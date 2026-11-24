// Simplified or Traditional Chinese, from a sample of characters that differ.
// Shared by planning (host) and the role board (client).
export function scriptVariant(text) {
  const traditional = text.match(/[體臺灣讓們這麼會說話聲書裡個過開門見學與還後來為沒時風龍]/g)?.length ?? 0
  const simplified = text.match(/[体台湾让们这么会说话声书里个过开门见学与还后来为没时风龙]/g)?.length ?? 0
  return traditional > simplified ? 'Hant' : 'Hans'
}
