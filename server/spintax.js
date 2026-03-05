/**
 *  Парсер спинтакса
 *  "{Привет|Здравствуйте}, {как дела|что нового}?"
 *  → "Здравствуйте, что нового?"
 */
function parseSpintax(text) {
  while (text.includes('{')) {
    text = text.replace(/\{([^{}]*)\}/g, (_, group) => {
      const options = group.split('|');
      return options[Math.floor(Math.random() * options.length)];
    });
  }
  return text;
}

module.exports = { parseSpintax };