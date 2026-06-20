# World Templates

`world-template-engine.js` provides reusable world definitions and lifecycle helpers. It separates world structure from hard-coded demo bootstrapping.

## Built-in templates

```text
empty_sandbox
cultivation_frontier
merchant_crossroads
```

List and build templates:

```js
const {
  createWorldTemplateRegistry,
  listWorldTemplates,
  createWorldFromTemplate,
} = require('./core/world-template-engine');

const registry = createWorldTemplateRegistry();
console.log(listWorldTemplates(registry));

const world = createWorldFromTemplate(registry, 'cultivation_frontier', {
  worldId: 'my-frontier',
  seedTicks: 10,
});
```

Run the template demo:

```bash
npm run templates
```

Select another template and seed tick count:

```bash
node world-engine/demo/template-demo.js merchant_crossroads 12
node world-engine/demo/template-demo.js empty_sandbox 0
```

## Register a custom template

```js
const {
  createWorldTemplateRegistry,
  registerWorldTemplate,
  createWorldFromTemplate,
} = require('./core/world-template-engine');

const registry = createWorldTemplateRegistry({ includeBuiltIns: false });

registerWorldTemplate(registry, {
  id: 'tiny_world',
  name: 'Tiny World',
  description: 'A custom minimal world.',
  seedTicks: 0,
  definition: {
    world: { id: 'tiny-world', seed: 7 },
    locations: [
      {
        id: 'tiny_origin',
        name: 'Tiny Origin',
        type: 'sanctuary',
        resources: { food: 100 },
      },
    ],
    connections: [],
    entities: [
      {
        id: 'tiny_agent',
        name: 'Tiny Agent',
        species: 'human',
        locationId: 'tiny_origin',
      },
    ],
    organizations: [],
  },
});

const world = createWorldFromTemplate(registry, 'tiny_world');
```

## Definition fields

```text
world                   id, seed, optional calendar
locations               location definitions
connections             [locationA, locationB] pairs
entities                entity definitions with optional species
organizations           organization definitions with optional members
organizationRelations   rival or ally links
resources               world-level resource map
```

Organization members are added through `addOrganizationMember`, so entity organization indexes and roles remain consistent.

## Reset a running world

```js
const {
  resetWorldFromTemplate,
} = require('./core/world-template-engine');

const nextWorld = resetWorldFromTemplate(currentWorld, registry, 'merchant_crossroads', {
  worldId: 'crossroads-season-two',
  seedTicks: 5,
  preserveAccounts: true,
  preserveAudit: true,
});
```

When `preserveAccounts` is enabled:

```text
account records are retained
active session tokens are retained
old player bindings are cleared
old player entities are not copied into the new world
```

This behavior allows a local or GM session to survive a world reset while requiring players to create new characters in the new world.
