import type { DoubtInfo, HumanResolution, HumanResolver } from '../../guard/types.js';

export class ChainResolver implements HumanResolver {
  constructor(private readonly resolvers: HumanResolver[]) {}

  async resolve(doubt: DoubtInfo): Promise<HumanResolution> {
    for (const resolver of this.resolvers) {
      const answer = await resolver.resolve(doubt).catch((): HumanResolution => 'unresolved');
      if (answer === 'happened' || answer === 'not_happened') return answer;
    }
    return 'unresolved';
  }
}
