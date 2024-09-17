import fs from 'fs';
import path from 'path';

class PathwayManager {
  constructor(filePath) {
    this.filePath = filePath;
  }

  loadPathways() {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error(`Error loading pathways from ${this.filePath}:`, error);
      return {};
    }
  }

  savePathways(pathways) {
    fs.writeFileSync(this.filePath, JSON.stringify(pathways, null, 2));
  }

  addPathway(name, pathway) {
    const pathways = this.loadPathways();
    if (pathways[name]) {
      throw new Error(`Pathway "${name}" already exists`);
    }
    if (!pathway.secret) {
      throw new Error('Secret is mandatory for adding a new pathway');
    }
    pathways[name] = pathway;
    this.savePathways(pathways);
  }

  updatePathway(name, updatedPathway, secret) {
    const pathways = this.loadPathways();
    if (!pathways[name]) {
      throw new Error(`Pathway "${name}" does not exist`);
    }
    if (pathways[name].secret !== secret) {
      throw new Error('Invalid secret');
    }
    pathways[name] = { ...pathways[name], ...updatedPathway };
    this.savePathways(pathways);
  }

  removePathway(name, secret) {
    const pathways = this.loadPathways();
    if (!pathways[name]) {
      throw new Error(`Pathway "${name}" does not exist`);
    }
    if (pathways[name].secret !== secret) {
      throw new Error('Invalid secret');
    }
    delete pathways[name];
    this.savePathways(pathways);
  }

  getTypeDefs() {
    return `#graphql
    scalar JSONObject

    input PathwayInput {
      prompt: String
      inputParameters: JSONObject
      model: String
      enableCache: Boolean
    }

    extend type Mutation {
      addPathway(name: String!, pathway: PathwayInput!, secret: String!): Boolean
      updatePathway(name: String!, pathway: PathwayInput!, secret: String!): Boolean
      deletePathway(name: String!, secret: String!): Boolean
    }
    `;
  }

  getResolvers() {
    return {
      Mutation: {
        addPathway: (_, { name, pathway, secret }) => {
          try {
            this.addPathway(name, { ...pathway, secret });
            return true;
          } catch (error) {
            throw new Error(error.message);
          }
        },
        updatePathway: (_, { name, pathway, secret }) => {
          console.log("updatePathway", name, pathway, secret);
          try {
            this.updatePathway(name, pathway, secret);
            return true;
          } catch (error) {
            throw new Error(error.message);
          }
        },
        deletePathway: (_, { name, secret }) => {
          try {
            this.removePathway(name, secret);
            return true;
          } catch (error) {
            throw new Error(error.message);
          }
        },
      },
    };
  }
}

export default PathwayManager;