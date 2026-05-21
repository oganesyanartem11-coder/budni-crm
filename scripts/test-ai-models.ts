import {
  getParserModel,
  getRecipesModel,
  getInboxModel,
  getFallbackModel,
} from '../src/lib/ai/models'

console.log('Parser:  ', getParserModel())
console.log('Recipes: ', getRecipesModel())
console.log('Inbox:   ', getInboxModel())
console.log('Fallback:', getFallbackModel())
