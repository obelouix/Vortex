import { IGameStored } from '../../extensions/gamemode_management/types/IGameStored';
import { IDiscoveryResult, IState } from '../../types/IState';
import {IFilterProps, ITableFilter} from '../../types/ITableAttribute';
import { activeGameId } from '../../util/selectors';
import { getSafe } from '../../util/storeHelper';

import * as React from 'react';
import { connect } from 'react-redux';
import Select from 'react-select';

export interface IConnectedProps {
  games: IGameStored[];
  discovered: { [id: string]: IDiscoveryResult };
}

export type IProps = IFilterProps & IConnectedProps;

function compare(lhs: IGameStored, rhs: IGameStored,
                 discovered: { [id: string]: IDiscoveryResult }) {
  const lPath = getSafe(discovered, [lhs.id, 'path'], undefined);
  const rPath = getSafe(discovered, [rhs.id, 'path'], undefined);

  if ((lPath === undefined) === (rPath === undefined)) {
    return lhs.name.localeCompare(rhs.name);
  } else {
    return lPath !== undefined ? -1 : 1;
  }
}

export class GameFilterComponent extends React.Component<IProps, {}> {
  public render(): JSX.Element {
    const { discovered, filter, games } = this.props;

    const options = [{
      label: '<Current Game>',
      value: '$',
    }].concat(games.slice()
      .sort((lhs, rhs) => compare(lhs, rhs, discovered))
      .map(game => ({
        label: game.shortName || game.name,
        value: game.id,
      })));

    return (
      <Select
        className='select-compact'
        options={options}
        value={filter}
        onChange={this.changeFilter}
        autosize={false}
      />
    );
  }

  private changeFilter = (value: { value: string, label: string }) => {
    const { attributeId, onSetFilter } = this.props;
    onSetFilter(attributeId, value !== null ? value.value : null);
  }
}

function mapStateToProps(state: IState): IConnectedProps {
  return {
    discovered: state.settings.gameMode.discovered,
    games: state.session.gameMode.known,
  };
}

const FilterConn = connect(mapStateToProps)(
  GameFilterComponent) as React.ComponentClass<IFilterProps>;

class GameFilter implements ITableFilter {
  public component = FilterConn;
  public raw = false;

  public matches(filter: any, value: any, state: IState): boolean {
    return (filter === '$')
      ? value.indexOf(activeGameId(state)) !== -1
      : value.indexOf(filter) !== -1;
  }
}

export default GameFilter;
