const english = {
  'st.imagegen.provider': 'Provider',
  'st.imagegen.local_provider': 'ComfyUI (localhost)',
  'st.imagegen.workflow': 'Workflow JSON (API format)',
  'st.imagegen.parameters': 'Model input JSON (optional)',
  'st.imagegen.setup': 'Setup guide ↗',
  'st.imagegen.hint.fal': 'Enter your fal.ai key and model ID. Test Connection checks authentication without generating media.',
  'st.imagegen.hint.openrouter': 'Enter an OpenRouter key and an image or video generation model ID. Test Connection checks the key and model catalog without generating media.',
  'st.imagegen.hint.comfyrouter': 'Enter a Comfy API key and provider/model ID. For models with other prompt fields, paste their input JSON using {{prompt}} where the text belongs. Test Connection reads model metadata.',
  'st.imagegen.hint.comfyui': 'Start ComfyUI locally, export the workflow in API format, and replace its positive prompt text with {{prompt}}. Include a Save Image or media output node. No API key is needed. Test Connection checks the local server; the workflow runs only when you request generation.',
  'st.imagegen.output': 'Generated media',
  'st.imagegen.save_output': 'Save generated media',
  'st.imagegen.unavailable_output': 'The saved media is unavailable.',
};
const turkish = {
  'st.imagegen.provider': 'Sağlayıcı',
  'st.imagegen.local_provider': 'ComfyUI (yerel sunucu)',
  'st.imagegen.workflow': 'İş akışı JSON (API biçimi)',
  'st.imagegen.parameters': 'Model girdisi JSON (isteğe bağlı)',
  'st.imagegen.setup': 'Kurulum rehberi ↗',
  'st.imagegen.hint.fal': 'fal.ai anahtarınızı ve model kimliğini girin. Bağlantı testi medya üretmeden kimlik doğrulamayı kontrol eder.',
  'st.imagegen.hint.openrouter': 'OpenRouter anahtarını ve görsel veya video üreten bir model kimliğini girin. Bağlantı testi medya üretmeden anahtarı ve model kataloğunu kontrol eder.',
  'st.imagegen.hint.comfyrouter': 'Comfy API anahtarını ve sağlayıcı/model kimliğini girin. Farklı istem alanları kullanan modeller için girdi JSON dosyasını yapıştırıp metnin yerine {{prompt}} yazın. Bağlantı testi model bilgilerini okur.',
  'st.imagegen.hint.comfyui': 'ComfyUI yerel sunucusunu başlatın, iş akışını API biçiminde dışa aktarın ve olumlu istem metnini {{prompt}} ile değiştirin. Save Image veya medya çıktı düğümü ekleyin. API anahtarı gerekmez. Bağlantı testi yerel sunucuyu kontrol eder; iş akışı yalnızca medya üretimi istediğinizde çalışır.',
  'st.imagegen.output': 'Üretilen medya',
  'st.imagegen.save_output': 'Üretilen medyayı kaydet',
  'st.imagegen.unavailable_output': 'Kaydedilen medya kullanılamıyor.',
};
export function getGenerativeMediaCopy(locale) {
  return { ...english, ...(locale === 'tr' ? turkish : {}) };
}
