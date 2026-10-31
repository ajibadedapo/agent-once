import type { DoubtInfo, HumanResolution, HumanResolver } from '../../guard/types.js';

const UNRESOLVED: HumanResolution = { outcome: 'unresolved' };

export class ChainResolver implements HumanResolver {
  constructor(private readonly resolvers: HumanResolver[]) {}

  async resolve(doubt: DoubtInfo, signal?: AbortSignal): Promise<HumanResolution> {
    for (const resolver of this.resolvers) {
      if (signal?.aborted === true) return UNRESOLVED;
      const answer = await resolver.resolve(doubt, signal).catch((): HumanResolution => UNRESOLVED);
      if (answer.outcome !== 'unresolved') return answer;
    }
    return UNRESOLVED;
  }
}
