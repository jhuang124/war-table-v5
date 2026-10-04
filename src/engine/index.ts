// Public engine API. Pure TypeScript: runs in the browser and in Node.

export * from './types';
export * from './mapData';
export {
  MISSIONS,
  missionText,
  missionComplete,
  missionHeadline,
  missionGoal,
  missionById,
  missionDeckFor,
  MISSION_TERRITORIES,
  MISSION_TERRITORIES_HELD,
  type Mission,
  type MissionId,
  type MissionSpec,
  type MissionGoal,
} from './missions';

export { createGame, defaultConfig, validateConfig, sanitizeConfig } from './setup';
export { applyAction, validateAction, cloneState, truceTargets, truceOffersTo } from './reducer';
export { legalActionsSummary, type LegalSummary, type TradeOption } from './summary';
export {
  reinforcementsFor,
  attackTargets,
  attackSources,
  fortifyTargets,
  fortifySources,
  fortifyPath,
  connectedPath,
  maxAttackDice,
  defendDiceFor,
  territoriesNeeded,
  territoryCount,
  totalArmies,
  ownedTerritories,
  ownsContinent,
  continentsOwned,
  continentOwners,
  checkWinner,
  turnLimitWinner,
  isTerritoryId,
  territoryName,
  isBorder,
  enemyNeighborArmies,
  alivePlayers,
} from './rules';
export {
  buildDeck,
  validSets,
  setValue,
  setValueFor,
  fixedSetValue,
  progressiveValue,
  isValidSetSymbols,
  bonusTerritoryFor,
  upcomingSetValues,
  WILD_CARD_IDS,
} from './cards';
export {
  winProbability,
  winProbabilityStopAt,
  blitzOdds,
  rollOutcomes,
  expectedRollLosses,
  type BlitzOdds,
} from './probability';
export { chooseAiAction, fallbackAction, PERSONAS, type Persona } from './ai';
export { nextRandom } from './rng';
export {
  PERSONALITIES,
  PERSONALITY_IDS,
  TEMPERAMENTS,
  isPersonality,
  personaFor,
  type PersonalityInfo,
  type Temperament,
} from './ai/personality';
export { acceptsTruce, chooseTruceProposal, truceScore } from './ai/diplomacy';
export {
  truceSentence,
  truceBetween,
  trucePartners,
  offerBetween,
  grudgeOf,
  grudgesOf,
  GRUDGE_DECAY,
  TRUCE_MIN_ROUNDS,
  TRUCE_MAX_ROUNDS,
} from './diplomacy';
export { NEUTRAL_SETUP } from './setup';
export { standingOf, standingReason, canAskPeace, type Standing } from './standing';
