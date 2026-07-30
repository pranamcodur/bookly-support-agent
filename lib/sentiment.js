// Very lightweight, keyword-based frustration detector for the rules engine
// (which has no real NLU). The LLM engine doesn't need this — it judges tone
// from the message itself, guided by its system prompt instead. This is a
// deliberately simple heuristic; a production version would want a real
// sentiment/classifier model rather than a regex.

const FRUSTRATION_RE =
  /\b(frustrat(ed|ing)|angry|furious|annoyed|irritated|unacceptable|ridiculous|terrible|awful|horrible|worst|useless|pathetic|fed up|sick of|done with this|waste of time|not happy|unhappy|disappoint(ed|ing)|this is a joke|forget it|screw this|so mad|really upset)\b/i;

function isFrustrated(text) {
  return FRUSTRATION_RE.test(text || '');
}

module.exports = { isFrustrated };
