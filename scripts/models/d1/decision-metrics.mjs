// Scoring for decision answers in the d1 answer shape ({ type, choice,
// probabilities } / { type, noul } / { type, score, probabilities }) against
// the balanced-V3 test labels. Used by the CPU parity check and the hardware
// eval so both report the same numbers as the d1 model card.

export function questionsOf(request) {
  return Object.fromEntries(request.questions.map(entry => [entry.id, entry.question]));
}

function optionProbabilities(answer, question) {
  if (question.type === 'noul') return { yes: answer.noul, no: 1 - answer.noul };
  return answer.probabilities || {};
}

export function predicted(answer, question) {
  if (question.type === 'noul') return answer.noul >= 0.5 ? 'yes' : 'no';
  if (question.type === 'choice') return answer.choice;
  return String(Math.round(answer.score));
}

export function scoreAnswers(requests, answersById) {
  const totals = { categorical: 0, correct: 0, completionPositives: 0, completionNegatives: 0, tp: 0, fp: 0, unknownTotal: 0, unknownCorrect: 0, scoreCount: 0, scoreAbsError: 0, truthProbability: 0, labelled: 0, missing: 0 };
  const byType = {};
  for (const request of requests) {
    for (const entry of request.questions) {
      const answer = answersById[entry.id];
      const question = entry.question;
      if (!answer) { totals.missing += 1; continue; }
      totals.labelled += 1;
      const label = entry.label;
      const type = byType[question.type] ||= { total: 0, correct: 0 };
      type.total += 1;
      const probabilities = optionProbabilities(answer, question);
      if (question.type === 'score') {
        totals.scoreCount += 1;
        totals.scoreAbsError += Math.abs(answer.score - label.expected_level);
        totals.truthProbability += Number(probabilities[String(label.selected_index)] ?? 0);
        if (Math.round(answer.score) === label.expected_level) type.correct += 1;
        continue;
      }
      totals.categorical += 1;
      const guess = predicted(answer, question);
      const right = guess === label.selected_option;
      if (right) { totals.correct += 1; type.correct += 1; }
      totals.truthProbability += Number(probabilities[label.selected_option] ?? 0);
      if (entry.is_completion_claim) {
        const positive = (entry.completion_positive_options || []).includes(label.selected_option);
        const claimed = (entry.completion_positive_options || []).includes(guess);
        if (positive) { totals.completionPositives += 1; if (claimed) totals.tp += 1; }
        else { totals.completionNegatives += 1; if (claimed) totals.fp += 1; }
        const unknown = entry.uncertainty_metadata?.unknown_option;
        if (unknown && label.selected_option === unknown) { totals.unknownTotal += 1; if (right) totals.unknownCorrect += 1; }
      }
    }
  }
  return {
    categorical: `${totals.correct}/${totals.categorical}`,
    categoricalAccuracy: totals.categorical ? totals.correct / totals.categorical : null,
    completion: { tp: totals.tp, positives: totals.completionPositives, fp: totals.fp, negatives: totals.completionNegatives,
      precision: totals.tp + totals.fp ? totals.tp / (totals.tp + totals.fp) : null,
      recall: totals.completionPositives ? totals.tp / totals.completionPositives : null },
    unknown: `${totals.unknownCorrect}/${totals.unknownTotal}`,
    scoreMae: totals.scoreCount ? totals.scoreAbsError / totals.scoreCount : null,
    meanTruthProbability: totals.labelled ? totals.truthProbability / totals.labelled : null,
    byType,
    missing: totals.missing,
  };
}

// Largest per-option probability difference and decision agreement between two
// answer sets for the same questions.
export function compareAnswers(requests, left, right) {
  let maxProbability = 0, maxScore = 0, agree = 0, total = 0, worst = null;
  for (const request of requests) {
    for (const entry of request.questions) {
      const a = left[entry.id], b = right[entry.id];
      if (!a || !b) continue;
      total += 1;
      const pa = optionProbabilities(a, entry.question), pb = optionProbabilities(b, entry.question);
      for (const key of Object.keys(pa)) {
        const difference = Math.abs(Number(pa[key]) - Number(pb[key]));
        if (difference > maxProbability) { maxProbability = difference; worst = entry.id; }
      }
      if (entry.question.type === 'score') maxScore = Math.max(maxScore, Math.abs(a.score - b.score));
      if (predicted(a, entry.question) === predicted(b, entry.question)) agree += 1;
    }
  }
  return { questions: total, decisionAgreement: `${agree}/${total}`, maxProbabilityDifference: maxProbability, maxExpectedScoreDifference: maxScore, worstQuestion: worst };
}
