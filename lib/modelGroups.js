const EMPTY_GROUP = Object.freeze({
    members: [],
    metadata: {},
});

const getModelGroup = (group) => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
        return EMPTY_GROUP;
    }

    return {
        ...group,
        members: Array.isArray(group.members) ? group.members : [],
        metadata: group.metadata && typeof group.metadata === 'object' ? group.metadata : {},
    };
};

const getModelGroupMembers = (group) => getModelGroup(group).members;

export {
    getModelGroup,
    getModelGroupMembers,
};
