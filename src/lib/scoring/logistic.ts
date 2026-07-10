/**
 * Minimal logistic regression (batch gradient descent, L2-regularized).
 * No external ML dependency - this is intentionally small since it's meant
 * to correct/calibrate the explainable Elo+form model once there's enough
 * logged outcome history, not to be a general-purpose ML library.
 */

export interface LogisticTrainingRow {
  x: number[]; // feature vector, x[0] should be 1 for the intercept
  y: number; // 0 or 1
}

export function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export function dot(a: number[], b: number[]): number {
  return a.reduce((sum, v, i) => sum + v * b[i], 0);
}

export function trainLogisticRegression(
  data: LogisticTrainingRow[],
  options: { learningRate?: number; l2?: number; epochs?: number } = {}
): number[] {
  const { learningRate = 0.1, l2 = 0.01, epochs = 800 } = options;
  const n = data[0].x.length;
  let weights = new Array(n).fill(0);

  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = new Array(n).fill(0);
    for (const { x, y } of data) {
      const p = sigmoid(dot(weights, x));
      const error = p - y;
      for (let i = 0; i < n; i++) grad[i] += error * x[i];
    }
    weights = weights.map((w, i) => w - learningRate * (grad[i] / data.length + l2 * w));
  }

  return weights;
}

export function predictLogistic(weights: number[], x: number[]): number {
  return sigmoid(dot(weights, x));
}
